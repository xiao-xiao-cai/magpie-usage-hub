import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readSourceId, readTimestamp } from '../sync/protocol.ts'
import { failure, jsonReply } from './http.ts'
import type { CenterLedger, SourceStatus } from './ledger.ts'
import { createCalendar, type Range } from './time.ts'

type Binding = string | number
type Query = { sourceId: string | null; model: string | null; via: string | null; range: Range }
type Totals = {
  calls: number; input: number; output: number; cacheRead: number; cacheWrite: number
  reasoning: number; cost: number; unpriced: number; cacheUnknownCalls: number
}
type Position = { timeMs: number; sourceId: string; rowKey: string }
type Detail = Position & {
  t: string; via: string; model: string; handedOn: number; input: number; output: number
  cacheRead: number; cacheWrite: number; reasoning: number; cacheUnknown: number
  cost: number | null; status: number | null; durationMs: number | null
}

const queryParameters = ['sourceId', 'model', 'via', 'period', 'from', 'to']
const staleAfterMs = 3 * 60_000
const emptyTotals: Totals = {
  calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  cost: 0, unpriced: 0, cacheUnknownCalls: 0,
}
const metricsSql = `
  COALESCE(SUM(1 - handed_on), 0) AS calls,
  COALESCE(SUM(input), 0) AS input,
  COALESCE(SUM(output), 0) AS output,
  COALESCE(SUM(cache_read), 0) AS cacheRead,
  COALESCE(SUM(cache_write), 0) AS cacheWrite,
  COALESCE(SUM(reasoning), 0) AS reasoning,
  COALESCE(SUM(CASE WHEN input + output > 0 THEN cost END), 0) AS cost,
  COALESCE(SUM(CASE WHEN input + output > 0 AND cost IS NULL THEN 1 ELSE 0 END), 0) AS unpriced,
  COALESCE(SUM(cache_unknown), 0) AS cacheUnknownCalls`

function readQueryTimestamp(value: string | null) {
  if (value === null || /\.\d{3}\d*[1-9]\d*(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null
  return readTimestamp(value)
}

function readQuery(params: URLSearchParams, calendar: ReturnType<typeof createCalendar>, now: number): Query | null {
  const sourceId = params.get('sourceId')
  const model = params.get('model')
  const via = params.get('via')
  if (sourceId !== null && sourceId !== 'local' && !readSourceId(sourceId)) return null
  if (model !== null && (model.length > 512 || /[\u0000-\u001f\u007f]/u.test(model))) return null
  if (via !== null && via !== 'through' && via !== 'direct') return null

  const period = params.get('period')
  if (params.has('from') || params.has('to')) {
    const from = readQueryTimestamp(params.get('from'))
    const to = readQueryTimestamp(params.get('to'))
    if (period !== null || from === null || to === null || from >= to) return null
    return { sourceId, model, via, range: { from, to } }
  }
  if (period !== null && period !== 'today' && period !== '7d' && period !== '30d') return null
  return { sourceId, model, via, range: calendar.period(period ?? '7d', now) }
}

function dimensionFilter(query: Query) {
  const conditions: string[] = []
  const values: Binding[] = []
  if (query.model !== null) {
    conditions.push('model = ?')
    values.push(query.model)
  }
  if (query.via !== null) {
    conditions.push('via = ?')
    values.push(query.via)
  }
  return { sql: conditions.map(condition => ` AND ${condition}`).join(''), values }
}

function freshness(source: SourceStatus, now: number) {
  if (!source.enabled || source.phase === 'paused') return 'paused'
  if (source.phase === 'recovery_required' || source.phase === 'rebuilding') return source.phase
  if (source.lastSeenAt === null) return 'new'
  if (now - Date.parse(source.lastSeenAt) > staleAfterMs) return 'offline'
  if (source.lastPageAt !== null && now - Date.parse(source.lastPageAt) > staleAfterMs) return 'stalled'
  if (source.phase === 'backfill' || source.hasMore) return 'catching_up'
  return 'current'
}

function describeSource(source: SourceStatus, now: number) {
  const { id, name, enabled, isLocal, phase, hasMore, lastSeenAt, lastSyncedAt, lastPageAt, recoveryReason, gap } = source
  return { id, name, enabled, isLocal, phase, hasMore, lastSeenAt, lastSyncedAt, lastPageAt, recoveryReason, gap,
    hasPublishedData: source.activeGeneration !== null, freshness: freshness(source, now) }
}

function summarizeSource(db: CenterLedger['db'], source: SourceStatus, query: Query, intervals: Range[],
  calendar: ReturnType<typeof createCalendar>, now: number) {
  const status = describeSource(source, now)
  const generation = source.activeGeneration
  if (generation === null) return { ...status, coverage: null, totals: emptyTotals, buckets: [], models: [] }

  const coverage = db.query<{ first: number | null; last: number | null }, Binding[]>(`
    SELECT MIN(time_ms) AS first, MAX(time_ms) AS last FROM usage_rows WHERE source_id = ? AND generation = ?
  `).get(source.id, generation)
  const filter = dimensionFilter(query)
  const scopedRows = `FROM usage_rows WHERE source_id = ? AND generation = ? AND time_ms >= ? AND time_ms < ?${filter.sql}`
  const values = [source.id, generation, query.range.from, query.range.to, ...filter.values]
  const totals = db.query<Totals, Binding[]>(`SELECT ${metricsSql} ${scopedRows}`).get(...values) ?? emptyTotals
  const models = db.query<Totals & { model: string }, Binding[]>(`
    SELECT model, ${metricsSql} ${scopedRows} GROUP BY model ORDER BY calls DESC, model
  `).all(...values).map(({ model, ...modelTotals }) => ({ model, totals: modelTotals }))
  const buckets = intervals.length === 0 ? [] : db.query<Totals & { fromMs: number; toMs: number }, Binding[]>(`
    WITH bounds (from_ms, to_ms) AS (VALUES ${intervals.map(() => '(?, ?)').join(', ')})
    SELECT from_ms AS fromMs, to_ms AS toMs, ${metricsSql}
    FROM bounds LEFT JOIN usage_rows ON source_id = ? AND generation = ?
      AND time_ms >= from_ms AND time_ms < to_ms${filter.sql}
    GROUP BY from_ms, to_ms ORDER BY from_ms
  `).all(...intervals.flatMap(({ from, to }) => [from, to]), source.id, generation, ...filter.values)
    .map(({ fromMs, toMs, ...bucketTotals }) => ({ from: calendar.format(fromMs), to: calendar.format(toMs), totals: bucketTotals }))
  return { ...status, totals, buckets, models, coverage: coverage?.first != null && coverage.last != null ? {
    from: new Date(coverage.first).toISOString(), to: new Date(coverage.last).toISOString(),
  } : null }
}

function encodePage(position: Position, scope: string, key: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(Buffer.from(scope))
  const body = Buffer.concat([cipher.update(JSON.stringify([position.timeMs, position.sourceId, position.rowKey])), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url')
}

function decodePage(token: string, scope: string, key: Buffer): Position | null {
  if (!/^[a-z0-9_-]{38,512}$/iu.test(token)) return null
  try {
    const bytes = Buffer.from(token, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      .setAuthTag(bytes.subarray(12, 28)).setAAD(Buffer.from(scope))
    const body = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
    const value: unknown = JSON.parse(body.toString('utf8'))
    if (!Array.isArray(value) || value.length !== 3) return null
    const [timeMs, sourceId, rowKey] = value
    if (typeof timeMs !== 'number' || !Number.isSafeInteger(timeMs) || typeof sourceId !== 'string'
      || typeof rowKey !== 'string' || !/^[a-f0-9]{64}$/u.test(rowKey)) return null
    return { timeMs, sourceId, rowKey }
  } catch {
    return null
  }
}

function readRows(db: CenterLedger['db'], query: Query, position: Position | null, limit: number) {
  const filter = dimensionFilter(query)
  const values = [query.range.from, query.range.to, ...filter.values]
  if (query.sourceId !== null) values.push(query.sourceId)
  if (position) values.push(position.timeMs, position.sourceId, position.rowKey)
  return db.query<Detail, Binding[]>(`
    SELECT source_id AS sourceId, time_ms AS timeMs, row_key AS rowKey, t, via, model,
      handed_on AS handedOn, input, output, cache_read AS cacheRead, cache_write AS cacheWrite, reasoning,
      cache_unknown AS cacheUnknown, cost, status, duration_ms AS durationMs
    FROM usage_rows JOIN sources ON sources.id = usage_rows.source_id AND sources.active_generation = usage_rows.generation
    WHERE time_ms >= ? AND time_ms < ?${filter.sql}${query.sourceId === null ? '' : ' AND source_id = ?'}
    ${position ? 'AND (time_ms, source_id, row_key) < (?, ?, ?)' : ''}
    ORDER BY time_ms DESC, source_id DESC, row_key DESC LIMIT ?
  `).all(...values, limit + 1)
}

export function createDashboard(ledger: Pick<CenterLedger, 'db' | 'getSources'>, timeZone: string) {
  const calendar = createCalendar(timeZone)
  const pageKey = randomBytes(32)

  return async (url: URL, signal: AbortSignal): Promise<Response> => {
    const rowsRequested = url.pathname === '/api/usage/rows'
    if (!rowsRequested && url.pathname !== '/api/usage') return failure(404, 'not_found')
    if (signal.aborted) return failure(503, 'dashboard_unavailable')
    const params = url.searchParams
    const allowed = [...queryParameters, ...(rowsRequested ? ['limit', 'page'] : ['bucket'])]
    if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length > 1)) {
      return failure(400, 'invalid_query')
    }

    const now = Date.now()
    const query = readQuery(params, calendar, now)
    if (!query) return failure(400, 'invalid_query')
    const range = { from: new Date(query.range.from).toISOString(), to: new Date(query.range.to).toISOString(), timeZone }
    const sources = ledger.getSources().filter(source => query.sourceId === null || query.sourceId === source.id)
    if (query.sourceId !== null && sources.length === 0) return failure(404, 'source_not_found')

    if (rowsRequested) {
      const limit = params.get('limit') ?? '50'
      if (!/^(?:[1-9]\d?|100)$/u.test(limit)) return failure(400, 'invalid_query')
      const token = params.get('page')
      const scope = JSON.stringify([query, sources.map(source => `${source.id}:${source.activeGeneration}`).sort()])
      const position = token === null ? null : decodePage(token, scope, pageKey)
      if (token !== null && !position) return failure(400, 'invalid_page')
      const page = readRows(ledger.db, query, position, Number(limit))
      const rows = page.slice(0, Number(limit))
      const nextPage = page.length > rows.length ? encodePage(rows[rows.length - 1], scope, pageKey) : null
      return jsonReply({ range, rows: rows.map(({ timeMs, rowKey, handedOn, cacheUnknown, ...row }) => ({
        ...row, handedOn: Boolean(handedOn), cacheUnknown: Boolean(cacheUnknown),
      })), nextPage })
    }

    const bucket = params.get('bucket')
    if (bucket !== null && bucket !== 'hour' && bucket !== 'day') return failure(400, 'invalid_query')
    const intervals = bucket === null ? [] : calendar.buckets(query.range, bucket)
    if (!intervals) return failure(400, 'bucket_range_too_large')
    return jsonReply({ range, sources: sources.map(source => summarizeSource(ledger.db, source, query, intervals, calendar, now)) })
  }
}
