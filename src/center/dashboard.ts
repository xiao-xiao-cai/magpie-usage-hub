import type { Database } from 'bun:sqlite'
import { requestDirect } from '../gateway/direct.ts'
import { isSourceId } from './http.ts'

const requestsPath = '/v1/magpie/usage/requests'
const pageSize = 25
const digestPattern = /^[0-9a-f]{64}$/
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

type Period = 'today' | '7d' | '30d'
type NativeScope = 'through' | 'direct'

type Totals = {
  attempts: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  unpriced: number
}

type DetailRow = Pick<Totals, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> & {
  time: string
  provider: string
  model: string
  status: number | null
  canceled: boolean
  cost: number | null
  rid?: string
  sourceInstanceId?: string
}

type DetailPage = { scope: string; offset: number; limit: number; total: number; rows: DetailRow[] }
type NativePage = { since: string; totals: Totals; detail: DetailPage }
type HubUsage = { totals: Totals; sources: { id: string; name?: string; totals: Totals }[]; detail: DetailPage | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readTime(value: unknown): string {
  if (typeof value !== 'string' || !timestampPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('invalid_usage_time')
  }
  return value
}

function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid_usage_count')
  return value
}

function readCost(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid_usage_cost')
  return value
}

function readTotals(value: unknown, attempts: number): Totals {
  if (!isRecord(value)) throw new Error('invalid_usage_totals')
  const unpriced = readCount(value.unpriced)
  if (unpriced > attempts) throw new Error('invalid_usage_totals')
  return {
    attempts, input: readCount(value.input), output: readCount(value.output),
    cacheRead: readCount(value.cache_read), cacheWrite: readCount(value.cache_write),
    cost: readCost(value.cost), unpriced,
  }
}

function sumTotals(totals: readonly Totals[]): Totals {
  return totals.reduce((sum, row) => ({
    attempts: sum.attempts + row.attempts,
    input: sum.input + row.input,
    output: sum.output + row.output,
    cacheRead: sum.cacheRead + row.cacheRead,
    cacheWrite: sum.cacheWrite + row.cacheWrite,
    cost: sum.cost + row.cost,
    unpriced: sum.unpriced + row.unpriced,
  }), { attempts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 })
}

function readDetail(value: unknown, kind: 'native' | 'hub'): DetailRow {
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.model !== 'string'
      || (kind === 'native' && typeof value.priced !== 'boolean')) throw new Error('invalid_usage_detail')
  const status = readCount(value.status)
  if ((kind === 'hub' || status !== 0) && (status < 100 || status > 599)) throw new Error('invalid_usage_status')
  const priced = kind === 'native' ? value.priced === true : value.cost !== undefined
  return {
    time: readTime(value.t), provider: value.provider, model: value.model,
    status: status === 0 ? null : status,
    canceled: kind === 'native' ? value.canceled === true : value.err === 'the agent canceled the request',
    input: readCount(value.in ?? 0), output: readCount(value.out ?? 0),
    cacheRead: readCount(value.cache_read ?? 0), cacheWrite: readCount(value.cache_write ?? 0),
    cost: priced ? readCost(value.cost) : null,
  }
}

async function readNative(
  baseUrl: URL, timeoutMs: number, period: Period, scope: NativeScope, offset: number, limit: number,
): Promise<NativePage> {
  const endpoint = new URL(requestsPath, baseUrl)
  endpoint.search = new URLSearchParams({ period, computer: 'this', via: scope, offset: String(offset), limit: String(limit) }).toString()
  const response = await requestDirect(endpoint, { method: 'GET' }, AbortSignal.timeout(timeoutMs))
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error('native_usage_unavailable')
  }
  const payload: unknown = await response.json()
  if (!isRecord(payload) || payload.period !== period || !Array.isArray(payload.rows) || !Array.isArray(payload.series)
      || !isRecord(payload.series[0])) throw new Error('invalid_native_usage')
  const total = readCount(payload.total)
  const returnedOffset = readCount(payload.offset)
  if (returnedOffset !== Math.min(offset, total) || payload.rows.length !== Math.min(total - returnedOffset, limit)) {
    throw new Error('invalid_native_usage_page')
  }
  const rows = limit === pageSize ? payload.rows.map(row => readDetail(row, 'native')) : []
  return {
    since: new Date(readTime(payload.series[0].time)).toISOString(), totals: readTotals(payload[scope], total),
    detail: { scope, offset: returnedOffset, limit, total, rows },
  }
}

function readHub(database: Database, since: string, scope: string, offset: number): HubUsage {
  const sinceMs = Date.parse(since)
  const cells = database.query<Record<string, unknown>, [number]>(`
    SELECT summary.*, managed_sources.name FROM (
      SELECT source_instance_id AS id, COUNT(*) AS attempts,
             TOTAL(json_extract(row_json, '$.in')) AS input,
             TOTAL(json_extract(row_json, '$.out')) AS output,
             TOTAL(json_extract(row_json, '$.cache_read')) AS cache_read,
             TOTAL(json_extract(row_json, '$.cache_write')) AS cache_write,
             TOTAL(json_extract(row_json, '$.cost')) AS cost,
             COUNT(*) - COUNT(json_extract(row_json, '$.cost')) AS unpriced
      FROM usage_reports WHERE called_at_ms >= ? GROUP BY source_instance_id
    ) AS summary LEFT JOIN managed_sources ON managed_sources.id = summary.id ORDER BY summary.id
  `).all(sinceMs)
  const sources = cells.map(cell => {
    if (!isSourceId(cell.id)) throw new Error('invalid_usage_source')
    const name = typeof cell.name === 'string' ? cell.name : undefined
    return { id: cell.id, ...(name === undefined ? {} : { name }), totals: readTotals(cell, readCount(cell.attempts)) }
  })
  const totals = sumTotals(sources.map(source => source.totals))
  if (scope === 'through' || scope === 'direct') return { totals, sources, detail: null }

  const total = scope === 'reported' ? totals.attempts : sources.find(source => source.id === scope)?.totals.attempts ?? 0
  const pageOffset = Math.min(offset, total)
  const select = 'SELECT rid, source_instance_id, called_at_ms, row_json FROM usage_reports WHERE called_at_ms >= ?'
  const page = 'ORDER BY called_at_ms DESC, rid DESC LIMIT ? OFFSET ?'
  const rows = scope === 'reported'
    ? database.query(`${select} ${page}`).all(sinceMs, pageSize, pageOffset)
    : database.query(`${select} AND source_instance_id = ? ${page}`).all(sinceMs, scope, pageSize, pageOffset)
  const details = rows.map(entry => {
    if (!isRecord(entry) || !isSourceId(entry.source_instance_id) || typeof entry.rid !== 'string'
        || typeof entry.row_json !== 'string') throw new Error('invalid_hub_usage_row')
    const prefix = `mpu1.${entry.source_instance_id}.`
    if (entry.rid.length !== prefix.length + 64 || !entry.rid.startsWith(prefix) || !digestPattern.test(entry.rid.slice(prefix.length))) {
      throw new Error('invalid_hub_usage_rid')
    }
    const payload: unknown = JSON.parse(entry.row_json)
    const row = readDetail(payload, 'hub')
    if (Date.parse(row.time) !== entry.called_at_ms) throw new Error('invalid_hub_usage_time')
    return { ...row, rid: entry.rid, sourceInstanceId: entry.source_instance_id }
  })
  return { totals, sources, detail: { scope, offset: pageOffset, limit: pageSize, total, rows: details } }
}

function calendarStart(period: Period): string {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (period === '7d' ? 6 : period === '30d' ? 29 : 0))
  return start.toISOString()
}

export function createDashboard(database: Database | null, centerGatewayUrl: URL, timeoutMs: number) {
  if (!['127.0.0.1', '[::1]'].includes(centerGatewayUrl.hostname) || !['http:', 'https:'].includes(centerGatewayUrl.protocol)
      || centerGatewayUrl.href !== `${centerGatewayUrl.origin}/`) throw new Error('invalid_center_local_gateway')
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  return async (url: URL): Promise<Response> => {
    const period = url.searchParams.get('period') ?? '7d'
    const scope = url.searchParams.get('scope') ?? 'through'
    const offsetText = url.searchParams.get('offset') ?? '0'
    const offset = Number(offsetText)
    if ((period !== 'today' && period !== '7d' && period !== '30d') || !/^\d+$/.test(offsetText)
        || !Number.isSafeInteger(offset) || (!['through', 'direct', 'reported'].includes(scope) && !isSourceId(scope))) {
      return Response.json({ code: 'invalid_usage_query' }, { status: 400 })
    }

    const [through, directPage] = await Promise.all((['through', 'direct'] as const).map(via => (
      readNative(centerGatewayUrl, timeoutMs, period, via, scope === via ? offset : 0, scope === via ? pageSize : 1)
        .catch(() => null)
    )))
    const aligned = !through || !directPage || through.since === directPage.since
    const direct = aligned ? directPage : null
    const local = through && direct ? sumTotals([through.totals, direct.totals]) : null
    const nativeSince = through?.since ?? direct?.since
    const since = nativeSince ?? calendarStart(period)
    let hub: HubUsage | null = null
    try {
      if (database) hub = readHub(database, since, scope, offset)
    } catch {
      hub = null
    }
    return Response.json({
      schema: 'magpie-usage-hub/usage-v1', period,
      window: { since, timeZone, basis: nativeSince ? 'native' : 'local_calendar' },
      totals: {
        local, through: through?.totals ?? null, direct: direct?.totals ?? null, hub: hub?.totals ?? null,
        combined: local && hub ? sumTotals([local, hub.totals]) : null,
      },
      sources: hub?.sources ?? null,
      detail: (scope === 'through' ? through?.detail : scope === 'direct' ? direct?.detail : hub?.detail) ?? null,
    })
  }
}
