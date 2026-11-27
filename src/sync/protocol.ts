import { isRecord } from '../center/http.ts'

export const pageLimit = 100

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const timestampPattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u
const cursorFailures = ['cursor_expired', 'cursor_reset', 'cursor_filter_changed', 'cursor_invalid'] as const
const phases = ['backfill', 'sync', 'rebuilding', 'recovery_required', 'paused'] as const

export type CursorFailure = typeof cursorFailures[number]
export type SyncPhase = typeof phases[number]
export type Checkpoint = {
  centerId: string
  sourceId: string
  revision: string
  cursor: string
  phase: SyncPhase
  hasMore: boolean
  lastSyncedAt: string | null
}
export type RowChange = { rowKey: string; seq: number }
export type UsageRow = RowChange & {
  t: string
  via: 'through' | 'direct'
  model: string
  handedOn: boolean
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cacheUnknown: boolean
  cost: number | null
  status: number | null
  durationMs: number | null
}
export type PageSubmission = {
  sourceId: string
  revision: string
  nextCursor: string
  hasMore: boolean
  upserts: UsageRow[]
  removals: RowChange[]
}
export type PageReceipt = { checkpoint: Checkpoint; upserted: number; removed: number }
export type RecoveryReport = { sourceId: string; revision: string; reason: CursorFailure }

export class ProtocolFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

export function readRevision(value: unknown): string | null {
  return typeof value === 'string' && value.length === 36 && uuidPattern.test(value) ? value : null
}

export function readSourceId(value: unknown): string | null {
  return value === 'local' ? value : readRevision(value)
}

export function readDigest(value: unknown): string | null {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/iu.test(value) ? value.toLowerCase() : null
}

export function readTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !timestampPattern.test(value)) return null
  const date = value.slice(0, 10)
  const midnight = new Date(`${date}T00:00:00Z`)
  const time = Date.parse(value)
  if (!Number.isFinite(time) || !Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date) return null
  return time
}

export function readCursor(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 1024 && /^[\x21-\x7e]+$/u.test(value) && value !== 'now' ? value : null
}

export function readCursorFailure(value: unknown): CursorFailure | null {
  return cursorFailures.find(code => code === value) ?? null
}

function isCount(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function onlyFields(value: Record<string, unknown>, fields: readonly string[]) {
  return Object.keys(value).every(key => fields.includes(key))
}

function readChange(value: unknown): RowChange {
  if (!isRecord(value)) throw new ProtocolFailure('invalid_page_row')
  const rowKey = readDigest(value.rowKey)
  if (!rowKey || rowKey !== value.rowKey || !isCount(value.seq, 1)) throw new ProtocolFailure('invalid_page_row')
  return { rowKey, seq: value.seq }
}

const usageFields = ['rowKey', 'seq', 't', 'via', 'model', 'handedOn', 'input', 'output', 'cacheRead',
  'cacheWrite', 'reasoning', 'cacheUnknown', 'cost', 'status', 'durationMs'] as const

function readUsageRow(value: unknown): UsageRow {
  if (!isRecord(value) || !onlyFields(value, usageFields)) throw new ProtocolFailure('invalid_page_row')
  const { t, via, model, handedOn, input, output, cacheRead, cacheWrite, reasoning, cacheUnknown, cost, status, durationMs } = value
  if (typeof t !== 'string' || readTimestamp(t) === null || (via !== 'through' && via !== 'direct')
    || typeof model !== 'string' || model.length > 512 || /[\u0000-\u001f\u007f]/u.test(model)
    || typeof handedOn !== 'boolean' || typeof cacheUnknown !== 'boolean'
    || !isCount(input) || !isCount(output) || !isCount(cacheRead) || !isCount(cacheWrite) || !isCount(reasoning)
    || (cost !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0))
    || (status !== null && !isCount(status, 100, 599)) || (durationMs !== null && !isCount(durationMs))) {
    throw new ProtocolFailure('invalid_page_row')
  }
  return { ...readChange(value), t, via, model, handedOn, input, output, cacheRead, cacheWrite, reasoning, cacheUnknown, cost, status, durationMs }
}

export function readPageSubmission(value: unknown): PageSubmission {
  if (!isRecord(value) || !onlyFields(value, ['sourceId', 'revision', 'nextCursor', 'hasMore', 'upserts', 'removals'])) {
    throw new ProtocolFailure('invalid_page')
  }
  const sourceId = readSourceId(value.sourceId)
  const revision = readRevision(value.revision)
  const nextCursor = readCursor(value.nextCursor)
  if (!sourceId || !revision || !nextCursor || nextCursor === 'start' || typeof value.hasMore !== 'boolean'
    || !Array.isArray(value.upserts) || !Array.isArray(value.removals)
    || value.upserts.length + value.removals.length > pageLimit) throw new ProtocolFailure('invalid_page')
  const upserts = value.upserts.map(readUsageRow)
  const removals = value.removals.map(change => {
    if (!isRecord(change) || !onlyFields(change, ['rowKey', 'seq'])) throw new ProtocolFailure('invalid_page_row')
    return readChange(change)
  })
  const changes = [...upserts, ...removals]
  const keys = new Set(changes.map(value => value.rowKey))
  const sequences = new Set(changes.map(value => value.seq))
  if (keys.size !== changes.length || sequences.size !== changes.length) throw new ProtocolFailure('duplicate_page_change')
  return { sourceId, revision, nextCursor, hasMore: value.hasMore, upserts, removals }
}
