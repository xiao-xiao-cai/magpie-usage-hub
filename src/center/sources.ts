import { randomUUID } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { readConfigRevision, readGatewayUrl } from '../options.ts'
import { StateError } from '../state/errors.ts'
import { readStateJson, writeStateJson } from '../state/store.ts'
import { testNativeConnection } from './dashboard.ts'
import { failure, isRecord, jsonReply, readJsonBody } from './http.ts'

type Source = { id: string; name: string; gatewayUrl: string; enabled: boolean; key: string }
type Snapshot = { version: 1; revision: number; sources: readonly Source[] }

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/u.test(value)
}

function readFields(value: Record<string, unknown>) {
  const { name, enabled } = value
  const gateway = readGatewayUrl(value.gatewayUrl)
  if (typeof name !== 'string' || !name || name.trim() !== name || [...name].length > 80
    || /[\u0000-\u001f\u007f]/u.test(name) || typeof enabled !== 'boolean' || !gateway) return
  return { name, gatewayUrl: gateway.href, enabled }
}

function readSnapshot(value: unknown): Snapshot {
  if (value === undefined) return { version: 1, revision: 0, sources: [] }
  if (!isRecord(value) || value.version !== 1 || !isRevision(value.revision) || !Array.isArray(value.sources)) {
    throw new StateError('state_invalid')
  }
  const ids = new Set<string>()
  const sources = value.sources.map((entry: unknown): Source => {
    if (!isRecord(entry)) throw new StateError('state_invalid')
    const id = readConfigRevision(entry.id)
    const fields = readFields(entry)
    if (!id || ids.has(id) || !fields || !isKey(entry.key)) throw new StateError('state_invalid')
    ids.add(id)
    return { id, ...fields, key: entry.key }
  })
  return { version: 1, revision: value.revision, sources }
}

function describe(snapshot: Snapshot, status = 200): Response {
  return jsonReply({ revision: snapshot.revision, sources: snapshot.sources.map(({ id, name, gatewayUrl, enabled, key }) => ({
    id, name, gatewayUrl, enabled, credentialConfigured: key.length > 0,
  })) }, status)
}

function readDraft(value: unknown, snapshot: Snapshot) {
  if (!isRecord(value) || !isRevision(value.revision)) return failure(400, 'invalid_source')
  const fields = readFields(value)
  const id = readConfigRevision(value.id)
  if (!fields || (value.id !== undefined && !id) || (value.key !== undefined && !isKey(value.key))) {
    return failure(400, 'invalid_source')
  }
  if (value.revision !== snapshot.revision) return failure(409, 'revision_conflict')
  const existing = id ? snapshot.sources.find(source => source.id === id) : undefined
  if (id && !existing) return failure(404, 'source_not_found')
  const key = value.key ?? (existing?.gatewayUrl === fields.gatewayUrl ? existing.key : undefined)
  if (key === undefined) return failure(400, 'key_required')
  return { id, ...fields, key }
}

export async function openPullSources(directory: string, timeoutMs: number) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) {
    throw new StateError('state_invalid')
  }
  let snapshot = readSnapshot(await readStateJson(directory, 'sources.json'))
  let queue = Promise.resolve()

  function save(value: unknown): Promise<Response> {
    const result = queue.then(async () => {
      const draft = readDraft(value, snapshot)
      if (draft instanceof Response) return draft
      const revision = snapshot.revision + 1
      if (!isRevision(revision)) return failure(503, 'source_save_failed')
      const source: Source = { ...draft, id: draft.id ?? randomUUID() }
      const sources = draft.id
        ? snapshot.sources.map(existing => existing.id === draft.id ? source : existing)
        : [...snapshot.sources, source]
      const next: Snapshot = { version: 1, revision, sources }
      try {
        await writeStateJson(directory, 'sources.json', next)
      } catch {
        return failure(503, 'source_save_failed')
      }
      snapshot = next
      return describe(next, draft.id ? 200 : 201)
    })
    queue = result.then(() => {}, () => {})
    return result
  }

  return {
    getSources: () => snapshot.sources,
    async manage(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname
      const testing = path === '/api/sources/test'
      if (!testing && path !== '/api/sources') return failure(404, 'source_not_found')
      if (!testing && request.method === 'GET') return describe(snapshot)
      if (request.method !== 'POST') {
        return new Response(null, { status: 405, headers: { Allow: testing ? 'POST' : 'GET, POST' } })
      }
      const body = await readJsonBody(request, 16 * 1024)
      if (body instanceof Response) return body
      if (!testing) return save(body.value)
      const draft = readDraft(body.value, snapshot)
      if (draft instanceof Response) return draft
      return jsonReply(await testNativeConnection(draft, timeoutMs, request.signal))
    },
  }
}
