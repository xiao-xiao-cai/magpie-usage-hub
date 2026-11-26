import { createHash } from 'node:crypto'

const requiredTextFields = ['agent', 'provider', 'model'] as const
const optionalTextFields = ['req', 'served', 'effort'] as const
const tokenFields = ['in', 'out', 'cache_read', 'cache_write', 'cache_write_1h', 'reasoning'] as const
const timingFields = ['ms', 'ttft_ms', 'first_text_ms', 'flow_ms'] as const
const timestampPattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
const earliestTimestamp = Date.UTC(2000, 0, 1)
const maxTokens = 100_000_000
const maxMillis = 86_400_000
const maxCost = 10_000
const maxBatchRows = 200
const maxBatchBytes = 1024 * 1024

type RequiredText = (typeof requiredTextFields)[number]
type OptionalText = (typeof optionalTextFields)[number]
type Metric = (typeof tokenFields)[number] | (typeof timingFields)[number]

export type ReportRow = Record<RequiredText, string> & Partial<Record<OptionalText, string>> &
  Partial<Record<Metric, number>> & {
    t: string
    status: number
    rid: string
    cost?: number
    err?: string
  }

export class MappingFailure extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'MappingFailure'
    this.code = code
  }
}

function readText(value: unknown, field: RequiredText | OptionalText): string {
  if (typeof value !== 'string') throw new MappingFailure(`invalid_${field}`)
  const text = value.trim()
  if ([...text].length > 256 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new MappingFailure(`invalid_${field}`)
  }
  return text
}

function readRequiredText(row: Record<string, unknown>, field: RequiredText): string {
  const text = readText(row[field], field)
  if (text === '') throw new MappingFailure(`invalid_${field}`)
  return text
}

function readInteger(value: unknown, field: Metric | 'status', minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new MappingFailure(`invalid_${field}`)
  }
  return value
}

function readTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !timestampPattern.test(value)) throw new MappingFailure('invalid_t')
  const timestamp = Date.parse(value)
  const calendarDay = value.slice(0, 10)
  const midnight = new Date(`${calendarDay}T00:00:00Z`)
  if (!Number.isFinite(timestamp) || timestamp < earliestTimestamp ||
      !Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== calendarDay) {
    throw new MappingFailure('invalid_t')
  }
  return value
}

export function mapUsageRow(
  row: Record<string, unknown>, sourceId: string, callerKeyId: string, includesTime?: (timestamp: string) => boolean,
): ReportRow | null {
  if (typeof row.origin !== 'string') throw new MappingFailure('invalid_origin')
  if (row.origin !== 'gateway') return null
  if (row.computer !== undefined && typeof row.computer !== 'string') {
    throw new MappingFailure('invalid_computer')
  }
  if (row.computer) return null
  if (row.callerKeyId !== callerKeyId) throw new MappingFailure('unexpected_caller_key')
  const timestamp = readTimestamp(row.t)
  if (includesTime && !includesTime(timestamp)) return null
  if (typeof row.id !== 'string' || row.id.trim() === '') throw new MappingFailure('invalid_row_id')

  const digest = createHash('sha256').update(row.id, 'utf8').digest('hex')
  const report: ReportRow = {
    t: timestamp,
    agent: readRequiredText(row, 'agent'),
    provider: readRequiredText(row, 'provider'),
    model: readRequiredText(row, 'model'),
    status: readInteger(row.status, 'status', 100, 599),
    rid: `mpu1.${sourceId}.${digest}`,
  }

  for (const field of optionalTextFields) {
    if (row[field] === undefined) continue
    const text = readText(row[field], field)
    if (text !== '') report[field] = text
  }
  for (const field of tokenFields) {
    if (row.cache_unknown === true && field.startsWith('cache_')) continue
    const value = row[field]
    if (value !== undefined) report[field] = readInteger(value, field, 0, maxTokens)
  }
  for (const field of timingFields) {
    const value = row[field]
    if (value !== undefined) report[field] = readInteger(value, field, 0, maxMillis)
  }

  if ((report.cache_write_1h ?? 0) > (report.cache_write ?? 0)) {
    throw new MappingFailure('invalid_cache_write_1h')
  }
  const firstText = report.first_text_ms ?? 0
  const firstContent = report.ttft_ms ?? 0
  if ((report.ms !== undefined && firstText > report.ms) ||
      (firstText > 0 && firstContent > 0 && firstText < firstContent)) {
    throw new MappingFailure('invalid_first_text_ms')
  }
  if (report.ms !== undefined && (report.flow_ms ?? 0) > Math.floor(report.ms * 10 / 8) + 1) {
    throw new MappingFailure('invalid_flow_ms')
  }

  if (row.priced !== undefined && typeof row.priced !== 'boolean') throw new MappingFailure('invalid_priced')
  if (row.priced === true) {
    const cost = row.cost
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > maxCost) {
      throw new MappingFailure('invalid_cost')
    }
    report.cost = cost
  }
  if (report.status === 499 && row.canceled === true) report.err = 'the agent canceled the request'
  return report
}

export function splitUsageBatches(rows: readonly ReportRow[]): { body: string; rids: string[] }[] {
  const batches: { body: string; rids: string[] }[] = []
  const encoder = new TextEncoder()
  let parts: string[] = []
  let rids: string[] = []
  let bodyBytes = 2

  for (const row of rows) {
    const part = JSON.stringify(row)
    const partBytes = encoder.encode(part).byteLength
    if (partBytes + 2 > maxBatchBytes) throw new MappingFailure('row_too_large')
    if (parts.length === maxBatchRows || (parts.length > 0 && bodyBytes + partBytes + 1 > maxBatchBytes)) {
      batches.push({ body: `[${parts.join(',')}]`, rids })
      parts = []
      rids = []
      bodyBytes = 2
    }
    if (parts.length > 0) bodyBytes += 1
    parts.push(part)
    rids.push(row.rid)
    bodyBytes += partBytes
  }

  if (parts.length > 0) batches.push({ body: `[${parts.join(',')}]`, rids })
  return batches
}
