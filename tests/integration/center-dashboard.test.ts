import { expect, test } from 'bun:test'
import { createDashboard } from '../../src/center/dashboard.ts'
import { openCenterLedger, type CenterLedger } from '../../src/center/ledger.ts'
import type { OtlpRow } from '../../src/center/otlp.ts'
import { createCalendar, readTimeZone } from '../../src/center/time.ts'
import type { UsageRow } from '../../src/sync/protocol.ts'

const window = { from: '2026-11-01T04:00:00Z', to: '2026-11-02T05:00:00Z' }
const windowInside = '2026-11-01T01:05:00-04:00'
const reportDigest = 'a'.repeat(64)

function row(seq: number, t: string, values: Partial<UsageRow> = {}): UsageRow {
  return { rowKey: seq.toString(16).padStart(64, 'f'), seq, t, via: 'through', model: 'sample', handedOn: false,
    input: 10, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1, cacheUnknown: false,
    cost: 0.125, status: 200, durationMs: 250, ...values }
}

function commit(ledger: CenterLedger, id: string, upserts: UsageRow[], hasMore = false) {
  const { revision } = ledger.checkpoint(id)
  return ledger.commit({ sourceId: id, revision, nextCursor: `fixture-${revision}`, hasMore, upserts, removals: [] })
}

function register(ledger: CenterLedger) {
  const { sources } = ledger.editSource({ action: 'create', revision: ledger.managementSnapshot().revision,
    name: 'Windows 模拟来源', digest: reportDigest, enabled: true })
  return sources.find(source => !source.isLocal)!.id
}

function otlpRow(seq: number, via: OtlpRow['via'], values: Partial<UsageRow> = {}): OtlpRow {
  const { seq: _sequence, ...fields } = row(seq, windowInside, values)
  return { ...fields, via }
}

function request(dashboard: ReturnType<typeof createDashboard>, path: string, params: Record<string, string>) {
  return dashboard(new URL(`http://127.0.0.1/api/${path}?${new URLSearchParams(params)}`), new AbortController().signal)
}

test('queries local accounting and received OTLP span usage by transport and provenance', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const windows = register(ledger)
    commit(ledger, 'local', [
      row(1, window.from),
      row(2, windowInside, { handedOn: true, cost: 0 }),
      row(3, '2026-11-01T01:15:00-05:00', { via: 'direct', model: 'other', cost: null, cacheUnknown: true, status: null }),
      row(4, '2026-11-01T01:15:00-05:00', { via: 'direct', model: 'other', input: 0, output: 0, cost: null }),
      row(5, window.to),
    ])
    const dashboard = createDashboard(ledger, 'America/New_York')
    const before = await (await request(dashboard, 'usage', { ...window, sourceId: windows })).json()
    expect(before.sources[0]).toMatchObject({ transport: 'otlp', phase: 'waiting', freshness: 'waiting', hasPublishedData: false })
    ledger.commitOtlp(reportDigest, [otlpRow(1, 'through', { input: 42 }), otlpRow(2, 'session', { model: 'session', input: 5 })])
    ledger.db.run('UPDATE sources SET last_seen_at = ? WHERE id = ?', ['2026-01-01T00:00:00Z', windows])
    const response = await request(dashboard, 'usage', { ...window, bucket: 'hour' })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.range).toEqual({ from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z', timeZone: 'America/New_York' })
    const [local, remote] = result.sources
    expect(local).toMatchObject({ transport: 'local' })
    expect(local.totals).toEqual({ calls: 3, input: 30, output: 6, cacheRead: 12, cacheWrite: 16,
      reasoning: 4, cost: 0.125, unpriced: 1, cacheUnknownCalls: 1 })
    expect(local.buckets).toHaveLength(25)
    expect(local.buckets[1]).toMatchObject({ from: '2026-11-01T01:00:00.000-04:00', to: '2026-11-01T01:00:00.000-05:00', totals: { calls: 0, input: 10 } })
    expect(local.buckets[2]).toMatchObject({ from: '2026-11-01T01:00:00.000-05:00', to: '2026-11-01T02:00:00.000-05:00', totals: { calls: 2, input: 10 } })
    expect(local.models).toMatchObject([{ model: 'other', totals: { calls: 2 } }, { model: 'sample', totals: { calls: 1 } }])
    expect(local.coverage).toEqual({ from: result.range.from, to: result.range.to })
    expect(remote).toMatchObject({ id: windows, transport: 'otlp', phase: 'receiving', freshness: 'receiving',
      totals: { calls: 2, input: 47 }, lastSyncedAt: null })
    expect(remote).not.toHaveProperty('activeGeneration')
    expect(remote).not.toHaveProperty('credentials')
    ledger.db.run('UPDATE sources SET last_page_at = ? WHERE id = ?', ['2026-01-01T00:00:00Z', 'local'])
    const stalled = await (await request(dashboard, 'usage', { ...window, sourceId: 'local' })).json()
    expect(stalled.sources[0]).toMatchObject({ freshness: 'stalled', totals: { calls: 3, input: 30 } })
    const filtered = await (await request(dashboard, 'usage', { ...window, sourceId: 'local', via: 'direct', model: 'other' })).json()
    expect(filtered.sources).toHaveLength(1)
    expect(filtered.sources[0]).toMatchObject({ id: 'local', totals: { calls: 2, input: 10, unpriced: 1 } })
    const session = await (await request(dashboard, 'usage/rows', { ...window, via: 'session' })).json()
    expect(session.rows).toMatchObject([{ sourceId: windows, model: 'session', via: 'session', input: 5 }])
  } finally {
    ledger.db.close()
  }
})

test('conversation combines local direct and remote session observations in every selection', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const windows = register(ledger)
    commit(ledger, 'local', [row(1, windowInside, { model: 'gateway' }),
      row(2, windowInside, { via: 'direct', input: 100, output: 30, cacheRead: 40, cacheWrite: 10, reasoning: 8, cost: 0.25 }),
      row(3, windowInside, { via: 'direct', cost: 0 }), row(4, windowInside, { via: 'direct', cost: null })])
    ledger.commitOtlp(reportDigest, [otlpRow(1, 'through', { model: 'gateway' }),
      otlpRow(2, 'session'), otlpRow(3, 'session', { model: 'comparison' })])
    const dashboard = createDashboard(ledger, 'America/New_York')
    const selection = { ...window, via: 'conversation' }
    const summary = await (await request(dashboard, 'usage', { ...selection, bucket: 'hour' })).json()
    const center = { calls: 3, input: 120, output: 34, cacheRead: 46, cacheWrite: 18, reasoning: 10, cost: 0.25, unpriced: 1 }
    const remote = { calls: 2, input: 20, cost: 0.25, unpriced: 0 }
    expect(summary.sources).toMatchObject([{ id: 'local', totals: center, models: [{ model: 'sample', totals: center }] },
      { id: windows, totals: remote, models: [{ model: 'comparison' }, { model: 'sample' }] }])
    expect(summary.sources[0].buckets[1].totals).toMatchObject(center)
    expect(summary.sources[1].buckets[1].totals).toMatchObject(remote)
    const scoped = await (await request(dashboard, 'usage', { ...selection, model: 'sample', bucket: 'hour' })).json()
    const sample = { calls: 1, input: 10, cost: 0.125, unpriced: 0 }
    expect(scoped.sources[1]).toMatchObject({ id: windows, totals: sample, models: [{ model: 'sample', totals: sample }] })
    expect(scoped.sources[1].buckets[1].totals).toMatchObject(sample)
    const sourceRows = await (await request(dashboard, 'usage/rows', { ...selection, sourceId: windows, model: 'sample' })).json()
    expect(sourceRows.rows).toMatchObject([{ via: 'session', model: 'sample', input: 10, cost: 0.125 }])
    const readPage = async (extra: Record<string, string> = {}) =>
      (await request(dashboard, 'usage/rows', { ...selection, limit: '2', ...extra })).json()
    const first = await readPage()
    for (const via of ['through', 'direct', 'session']) {
      expect(await readPage({ page: first.nextPage, via })).toEqual({ error: { code: 'invalid_page' } })
    }
    const second = await readPage({ page: first.nextPage })
    const third = await readPage({ page: second.nextPage })
    expect(third.nextPage).toBe(null)
    const records = [...first.rows, ...second.rows, ...third.rows]
    expect(records.map(record => record.via)).toEqual(['direct', 'direct', 'direct', 'session', 'session'])
    expect(records.slice(0, 3)).toMatchObject([{ cost: null }, { cost: 0 },
      { input: 100, output: 30, cacheRead: 40, cacheWrite: 10, reasoning: 8, cost: 0.25 }])
  } finally {
    ledger.db.close()
  }
})

test('includes cache-only OTLP fees and missing prices in each aggregate', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const windows = register(ledger)
    commit(ledger, 'local', [row(1, windowInside, { input: 0, output: 0, reasoning: 0 })])
    ledger.commitOtlp(reportDigest, [
      otlpRow(1, 'through', { input: 0, output: 0, cacheWrite: 0, reasoning: 0 }),
      otlpRow(2, 'session', { input: 0, output: 0, cacheRead: 0, reasoning: 0, cost: null }),
    ])
    const dashboard = createDashboard(ledger, 'UTC')
    const response = await request(dashboard, 'usage', { ...window, bucket: 'hour' })
    expect(response.status).toBe(200)
    const { sources } = await response.json()
    const expected = { cost: 0.125, unpriced: 1, cacheRead: 3, cacheWrite: 4 }
    const remote = sources.find((source: { id: string }) => source.id === windows)
    expect(remote.totals).toMatchObject(expected)
    expect(remote.models).toMatchObject([{ model: 'sample', totals: expected }])
    expect(remote.buckets[1].totals).toMatchObject(expected)
    expect(remote.buckets[0].totals).toMatchObject({ cost: 0, unpriced: 0 })
    expect(sources.find((source: { id: string }) => source.id === 'local').totals).toMatchObject({ cost: 0, unpriced: 0 })
  } finally {
    ledger.db.close()
  }
})

test('pages ties across sources in order with a private cursor scoped to the selection', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    register(ledger)
    commit(ledger, 'local', [row(1, windowInside), row(2, windowInside, { model: 'second' })])
    ledger.commitOtlp(reportDigest, [otlpRow(1, 'through', { model: 'remote' })])
    const dashboard = createDashboard(ledger, 'UTC')
    const fetchPage = async (params: Record<string, string> = {}) =>
      (await request(dashboard, 'usage/rows', { ...window, limit: '1', ...params })).json()
    const first = await fetchPage()
    const second = await fetchPage({ page: first.nextPage })
    const third = await fetchPage({ page: second.nextPage })
    expect([first, second, third].map(result => result.rows[0].model)).toEqual(['second', 'sample', 'remote'])
    expect(third.nextPage).toBe(null)
    expect(first.rows[0]).toMatchObject({ sourceId: 'local', t: windowInside, handedOn: false, status: 200, durationMs: 250 })
    expect(first.rows[0]).not.toHaveProperty('rowKey')
    expect(first.rows[0]).not.toHaveProperty('timeMs')
    expect(Buffer.from(first.nextPage, 'base64url').toString()).not.toContain(row(2, windowInside).rowKey)
    expect(await fetchPage({ model: 'second', page: first.nextPage })).toEqual({ error: { code: 'invalid_page' } })
    expect(await fetchPage({ page: 'a'.repeat(72) })).toEqual({ error: { code: 'invalid_page' } })
  } finally {
    ledger.db.close()
  }
})

test('keeps prior history visible during rebuild and switches to verified rows with a gap', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const original = row(1, windowInside)
    commit(ledger, 'local', [original])
    ledger.recover({ sourceId: 'local', revision: ledger.checkpoint('local').revision, reason: 'cursor_expired' })
    commit(ledger, 'local', [row(1, window.from, { rowKey: 'a'.repeat(64), model: 'new', input: 3 })], true)
    const dashboard = createDashboard(ledger, 'UTC')
    const during = await (await request(dashboard, 'usage', window)).json()
    expect(during.sources[0]).toMatchObject({ freshness: 'rebuilding', hasPublishedData: true, totals: { input: 10 } })
    const duringRows = await (await request(dashboard, 'usage/rows', window)).json()
    expect(duringRows.rows).toHaveLength(1)
    expect(duringRows.rows[0].model).toBe(original.model)
    commit(ledger, 'local', [])
    const after = await (await request(dashboard, 'usage', window)).json()
    expect(after.sources[0]).toMatchObject({ freshness: 'current', gap: { missingRows: 1 }, totals: { input: 3 } })
    const afterRows = await (await request(dashboard, 'usage/rows', window)).json()
    expect(afterRows.rows).toHaveLength(1)
    expect(afterRows.rows[0].model).toBe('new')
  } finally {
    ledger.db.close()
  }
})

test('validates offset timestamps and separates trend limits from historical summaries', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const dashboard = createDashboard(ledger, 'Asia/Shanghai')
    const outcomes = [
      { from: '2026-02-30T04:00:00Z', to: window.to },
      { from: '2026-11-01T04:00:00', to: window.to },
      { from: '2026-11-01T04:00:00.0001Z', to: window.to },
      { ...window, period: '7d' },
      { ...window, via: 'reported' },
    ]
    for (const params of outcomes) expect((await request(dashboard, 'usage', params as Record<string, string>)).status).toBe(400)
    const wide = { from: '2026-01-01T00:00:00+08:00', to: window.to }
    const trend = await request(dashboard, 'usage', { ...wide, bucket: 'hour' })
    expect(trend.status).toBe(400)
    expect(await trend.json()).toEqual({ error: { code: 'bucket_range_too_large' } })
    const summary = await (await request(dashboard, 'usage', wide)).json()
    expect(summary.sources[0]).toMatchObject({ freshness: 'new', hasPublishedData: false, totals: { calls: 0 }, buckets: [] })
    expect((await request(dashboard, 'usage/rows', { ...wide, limit: '101' })).status).toBe(400)
  } finally {
    ledger.db.close()
  }
})

test('calendar periods use local midnight and trend buckets track hour and date changes', () => {
  expect(readTimeZone('+05:30')).toBe(null)
  expect(readTimeZone('Not/AZone')).toBe(null)
  expect(readTimeZone('UTC')).toBe('UTC')
  const kolkata = createCalendar('Asia/Kolkata')
  const now = Date.parse('2026-01-01T21:00:00Z')
  expect(kolkata.period('today', now)).toEqual({ from: Date.parse('2026-01-01T18:30:00Z'), to: now })
  expect(kolkata.period('7d', now)).toEqual({ from: Date.parse('2025-12-26T18:30:00Z'), to: now })
  const newYork = createCalendar('America/New_York')
  const springDay = { from: Date.parse('2026-03-08T05:00:00Z'), to: Date.parse('2026-03-09T04:00:00Z') }
  expect(newYork.buckets(springDay, 'day')).toEqual([springDay])
  expect(newYork.buckets(springDay, 'hour')).toHaveLength(23)
  const lordHowe = createCalendar('Australia/Lord_Howe')
  const halfHourChange = { from: Date.parse('2026-04-04T14:00:00Z'), to: Date.parse('2026-04-04T16:30:00Z') }
  expect(lordHowe.buckets(halfHourChange, 'hour')?.map(({ from, to }) => [lordHowe.format(from), lordHowe.format(to)])).toEqual([
    ['2026-04-05T01:00:00.000+11:00', '2026-04-05T01:30:00.000+10:30'],
    ['2026-04-05T01:30:00.000+10:30', '2026-04-05T02:00:00.000+10:30'],
    ['2026-04-05T02:00:00.000+10:30', '2026-04-05T03:00:00.000+10:30'],
  ])
})
