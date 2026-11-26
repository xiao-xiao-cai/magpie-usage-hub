import type { Database } from 'bun:sqlite'
import { timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { ReportRow } from '../sync/mapping.ts'
import { failure, isHexDigest, isRecord, isSourceId, jsonReply, readJsonBody } from './http.ts'
import { prepareReportWriter } from './ledger.ts'
import { createSourceRegistry, credentialDigest } from './sources.ts'

const requestsPath = '/v1/magpie/usage/requests'
const pairPath = '/v1/magpie/usage/pair'
const configPath = '/v1/magpie/usage/config'
const maxBatchRows = 200
const maxBatchBytes = 1024 * 1024
const requiredText = ['agent', 'provider', 'model'] as const
const optionalText = ['req', 'served', 'effort'] as const
const tokenFields = ['in', 'out', 'cache_read', 'cache_write', 'cache_write_1h', 'reasoning'] as const
const timingFields = ['ms', 'ttft_ms', 'first_text_ms', 'flow_ms'] as const
const reportFields = new Set<string>([
  'rid', 't', 'status', 'cost', 'err', ...requiredText, ...optionalText, ...tokenFields, ...timingFields,
])
const timestampPattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
const earliestTimestamp = Date.UTC(2000, 0, 1)
const cancellationText = 'the agent canceled the request'

type IngestCredential = { sourceInstanceId: string; key: Buffer }

async function readIngestCredentials(path: string): Promise<IngestCredential[]> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error()
    const windows = process.platform === 'win32'
    const file = await open(path, constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
    let payload: unknown
    try {
      const metadata = await file.stat()
      if (!metadata.isFile() || (!windows && (metadata.mode & 0o077) !== 0) || metadata.size > maxBatchBytes) {
        throw new Error()
      }
      payload = JSON.parse(await file.readFile('utf8'))
    } finally {
      await file.close()
    }
    if (!Array.isArray(payload)) throw new Error()
    const sourceIds = new Set<string>()
    const keys = new Set<string>()
    return payload.map((entry: unknown) => {
      if (!isRecord(entry) || Object.keys(entry).length !== 2) throw new Error()
      const { sourceInstanceId, key } = entry
      if (!isSourceId(sourceInstanceId) || !isHexDigest(key) || sourceIds.has(sourceInstanceId) || keys.has(key)) {
        throw new Error()
      }
      sourceIds.add(sourceInstanceId)
      keys.add(key)
      return { sourceInstanceId, key: Buffer.from(key, 'ascii') }
    })
  } catch {
    throw new Error('ingest_credentials_unavailable')
  }
}

export async function checkIngestCredentials(path: string): Promise<void> {
  await readIngestCredentials(path)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value === value.trim()
    && [...value].length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

function isTimestamp(value: unknown, latest: number): value is string {
  if (typeof value !== 'string' || value !== value.trim() || !timestampPattern.test(value)) return false
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp < earliestTimestamp || timestamp > latest) return false
  const day = value.slice(0, 10)
  const midnight = new Date(`${day}T00:00:00Z`)
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().slice(0, 10) === day
}

function readReport(value: unknown, latest: number): { report: ReportRow; sourceInstanceId: string } | null {
  if (!isRecord(value) || Object.keys(value).some((field) => !reportFields.has(field))) return null
  const { rid, t, status, agent, provider, model, cost, err } = value
  if (typeof rid !== 'string' || rid.length !== 106 || !isTimestamp(t, latest) || !isInteger(status, 100, 599)
    || !isText(agent) || !isText(provider) || !isText(model)) return null
  const [prefix, sourceInstanceId, digest] = rid.split('.')
  if (prefix !== 'mpu1' || !isSourceId(sourceInstanceId) || !isHexDigest(digest)) return null
  const report: ReportRow = { rid, t, status, agent, provider, model }
  for (const field of optionalText) {
    const text = value[field]
    if (text === undefined) continue
    if (!isText(text)) return null
    report[field] = text
  }
  for (const field of tokenFields) {
    const count = value[field]
    if (count === undefined) continue
    if (!isInteger(count, 0, 100_000_000)) return null
    report[field] = count
  }
  for (const field of timingFields) {
    const duration = value[field]
    if (duration === undefined) continue
    if (!isInteger(duration, 0, 86_400_000)) return null
    report[field] = duration
  }
  const firstText = report.first_text_ms ?? 0
  const firstContent = report.ttft_ms ?? 0
  if ((report.cache_write_1h ?? 0) > (report.cache_write ?? 0)
    || (report.ms !== undefined && (firstText > report.ms || (report.flow_ms ?? 0) > Math.floor(report.ms * 10 / 8) + 1))
    || (firstText > 0 && firstContent > 0 && firstText < firstContent)) return null
  if (cost !== undefined) {
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > 10_000) return null
    report.cost = cost
  }
  if (err !== undefined) {
    if (status !== 499 || err !== cancellationText) return null
    report.err = err
  }
  return { report, sourceInstanceId }
}

async function findLegacySource(keyFile: string | undefined, candidate: string): Promise<string | undefined> {
  if (!keyFile) return undefined
  const key = Buffer.from(candidate, 'ascii')
  let sourceInstanceId: string | undefined
  for (const credential of await readIngestCredentials(keyFile)) {
    if (timingSafeEqual(credential.key, key)) sourceInstanceId = credential.sourceInstanceId
  }
  return sourceInstanceId
}

export function serveIngest(
  database: Database, keyFile: string | undefined, port: number, hostname = '0.0.0.0',
  sources = createSourceRegistry(database),
) {
  const writeReports = prepareReportWriter(database)
  const writeManagedReports = database.transaction((digest: string, id: string, reports: ReportRow[]) => {
    const source = sources.reporter(digest)
    if (!source || source.id !== id) return failure(401, 'unauthorized')
    if (source.enabled !== 1) return failure(403, 'source_paused')
    if (reports.some(report => report.provider !== source.source_provider_id)) return failure(403, 'provider_mismatch')
    const receipt = writeReports(source.id, reports)
    if (receipt.accepted > 0) sources.markReport(source.id)
    return jsonReply(receipt)
  }).immediate
  return Bun.serve({
    port, hostname, maxRequestBodySize: maxBatchBytes * 2, idleTimeout: 30, development: false,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname !== requestsPath && pathname !== pairPath && pathname !== configPath) return failure(404, 'not_found')
      if (request.method !== (pathname === configPath ? 'GET' : 'POST')) return failure(405, 'method_not_allowed')
      const authorization = request.headers.get('authorization')
      const candidate = authorization?.slice(7)
      if (authorization?.slice(0, 7).toLowerCase() !== 'bearer ' || !isHexDigest(candidate)) {
        return failure(401, 'unauthorized')
      }
      const digest = credentialDigest(candidate)
      if (pathname === pairPath) {
        const body = await readJsonBody(request, 1024, 'invalid_pairing_request', 'request_too_large')
        if (body instanceof Response) return body
        const { value } = body
        if (!isRecord(value) || Object.keys(value).length !== 1 || !isHexDigest(value.credentialDigest)) {
          return failure(400, 'invalid_pairing_request')
        }
        try {
          const result = sources.pair(digest, value.credentialDigest)
          if (result === 'invalid_pairing_code') return failure(401, result)
          if (result === 'credential_conflict') return failure(409, result)
          return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
        } catch {
          return failure(503, 'sources_unavailable')
        }
      }
      if (pathname === configPath) {
        try {
          const config = sources.config(digest)
          return config ? jsonReply(config) : failure(401, 'unauthorized')
        } catch {
          return failure(503, 'sources_unavailable')
        }
      }

      let managed: ReturnType<typeof sources.reporter>
      try {
        managed = sources.reporter(digest)
      } catch {
        return failure(503, 'sources_unavailable')
      }
      if (managed && managed.enabled !== 1) return failure(403, 'source_paused')
      let sourceInstanceId = managed?.id
      try {
        sourceInstanceId ??= await findLegacySource(keyFile, candidate)
      } catch {
        return failure(503, 'ingest_credentials_unavailable')
      }
      if (sourceInstanceId === undefined) return failure(401, 'unauthorized')
      const body = await readJsonBody(request, maxBatchBytes, 'invalid_batch', 'batch_too_large')
      if (body instanceof Response) return body
      const { value: payload } = body
      if (!Array.isArray(payload) || payload.length === 0) return failure(400, 'invalid_batch')
      if (payload.length > maxBatchRows) return failure(413, 'batch_too_large')
      const latest = Date.now() + 60 * 60 * 1000
      const reports: ReportRow[] = []
      const rids = new Set<string>()
      for (const row of payload) {
        const validated = readReport(row, latest)
        if (!validated || rids.has(validated.report.rid)) return failure(400, 'invalid_batch')
        if (validated.sourceInstanceId !== sourceInstanceId) return failure(403, 'source_mismatch')
        rids.add(validated.report.rid)
        reports.push(validated.report)
      }
      try {
        if (managed) return writeManagedReports(digest, sourceInstanceId, reports)
        if (sources.find(sourceInstanceId)) return failure(401, 'unauthorized')
        return jsonReply(writeReports(sourceInstanceId, reports))
      } catch {
        return failure(503, 'ingest_ledger_unavailable')
      }
    },
    error() {
      return failure(500, 'ingest_unavailable')
    },
  })
}
