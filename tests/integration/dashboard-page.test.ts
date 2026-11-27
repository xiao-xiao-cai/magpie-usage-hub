import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const dashboard = readFileSync(new URL('../../ui/dashboard/dashboard.js', import.meta.url), 'utf8')
const diagnostics = readFileSync(new URL('../../ui/status.js', import.meta.url), 'utf8')
const options = readFileSync(new URL('../../page/options.js', import.meta.url), 'utf8')
const queryToken = 'e'.repeat(64)
const observedAt = '2026-11-27T10:00:00.000Z'
const range = { from: '2026-11-27T00:00:00.000Z', to: '2026-11-27T02:00:00.000Z', timeZone: 'Asia/Shanghai' }
const totals = { calls: 2, input: 11, output: 12, cacheRead: 4, cacheWrite: 3, reasoning: 2, cost: 0.001, unpriced: 1, cacheUnknownCalls: 1 }
const empty = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, unpriced: 0, cacheUnknownCalls: 0 }
const middle = '2026-11-27T01:00:00.000Z'
const buckets = [{ from: range.from, to: middle, totals }, { from: middle, to: range.to, totals }]
const local = { id: 'local', name: '中心本机', transport: 'local', freshness: 'current', lastSyncedAt: observedAt, hasPublishedData: true,
  coverage: { from: range.from, to: range.to }, totals, buckets, models: [{ model: '', totals }], gap: null }
const windows = { ...local, id: '01ed2b80-c848-48f1-b7a2-5852505416d5', name: 'Windows 合成来源', transport: 'otlp',
  freshness: 'receiving', lastSyncedAt: null, lastPageAt: observedAt }
const waiting = { ...windows, freshness: 'waiting', hasPublishedData: false, totals: empty, buckets: [], models: [] }
const row = { sourceId: windows.id, model: '', t: '2026-11-27T08:00:00+08:00', via: 'session', handedOn: false,
  input: 0, output: 0, cacheRead: 11, cacheWrite: 0, reasoning: 0, cacheUnknown: true, cost: null, status: null, durationMs: 0 }

class Control extends EventTarget {
  hidden = false
  disabled = false
  value = ''
  textContent = ''
  href = ''
  dateTime = ''
  tabIndex = -1
  children: Control[] = []
  attributes = new Map<string, string>()
  append(...children: Control[]) { this.children.push(...children) }
  replaceChildren(...children: Control[]) { this.children = children }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  focus() {}
}

function documentHarness() {
  const controls = new Map<string, Control>()
  function control(id: string) {
    if (!controls.has(id)) controls.set(id, new Control())
    return controls.get(id)!
  }
  return { control, document: { getElementById: control, querySelector: () => ({ content: queryToken }),
    createElement: () => new Control(), createElementNS: () => new Control() } }
}

function dashboardHarness(search = '') {
  const { control, document } = documentHarness()
  const requests: { path: string; init: RequestInit; pending: PromiseWithResolvers<Response> }[] = []
  const location = { search, reloads: 0, reload() { this.reloads++ } }
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  let currentTime = Date.parse(observedAt)
  class Clock extends Date {
    constructor(value?: string | number) { super(value ?? currentTime) }
  }
  runInNewContext(`${options}\n${dashboard}`, { document, AbortController, AbortSignal, URLSearchParams, Date: Clock, Intl, location,
    history: { replaceState(_state: unknown, _title: string, search: string) { location.search = search } },
    setTimeout(fn: () => void) { timers.set(++nextTimer, fn); return nextTimer }, clearTimeout(id: number) { timers.delete(id) },
    fetch(path: string, init: RequestInit) {
      const pending = Promise.withResolvers<Response>()
      requests.push({ path, init, pending })
      return pending.promise
    },
  })
  return { control, requests, location, timers,
    setClock(value: string) { currentTime = Date.parse(value) },
    click(id: string) { control(id).dispatchEvent(new Event('click')) },
    change(id: string, value: string) { control(id).value = value; control(id).dispatchEvent(new Event('change')) },
    params(index: number) { return Object.fromEntries(new URL(requests[index].path, 'https://fixture.example/dashboard/').searchParams) },
    async reply(index: number, data: unknown, status = 200) { requests[index].pending.resolve(Response.json(data, { status })); await Bun.sleep(0) },
  }
}

describe('dashboard page', () => {
  test('loads one gateway summary, aggregates exact amounts and exposes accessible trend points', async () => {
    const ui = dashboardHarness()
    expect(ui.params(0)).toEqual({ via: 'through', period: '7d', bucket: 'day' })
    expect(ui.requests[0].init).toMatchObject({ headers: { 'X-Magpie-Usage-Query': queryToken }, credentials: 'omit', redirect: 'error' })
    await ui.reply(0, { range, sources: [windows, local] })
    expect(ui.requests).toHaveLength(1)
    expect(ui.control('register-banner').hidden).toBe(true)
    expect(ui.control('results').hidden).toBe(false)
    expect(ui.control('kpi-tokens').textContent).toBe('46')
    expect(ui.control('token-note').textContent).toBe('输入 22 / 输出 24')
    expect(ui.control('kpi-cache').textContent).toBe('8')
    expect(ui.control('cache-note').textContent).toContain('2 条缓存未知')
    expect(ui.control('kpi-reasoning').textContent).toBe('4')
    expect(ui.control('kpi-calls').textContent).toBe('4')
    expect(ui.control('billed').textContent).toBe('$0.002 USD')
    expect(ui.control('unpriced').textContent).toBe('缺价 2 条')
    expect(ui.control('source-cards').children).toHaveLength(2)
    expect(ui.control('model-rows').children).toHaveLength(1)
    ui.click('layout-table')
    const [center, remote] = ui.control('summary-rows').children
    expect(center.children[0].children[0].textContent).toBe(local.name)
    expect(center.children[1].textContent).toBe('23')
    expect(remote.children.map(cell => cell.textContent).slice(1)).toEqual(['23', '2', '11 / 12', '4 / 3', '2', '$0.001', '1'])
    expect(remote.children[4].children[0].textContent).toContain('1 条缓存未知')
    ui.click('metric-cost')
    expect(ui.control('plot').attributes.get('aria-valuetext')).toContain('$0.002 已计价 · 2 条缺价')
    ui.control('plot').dispatchEvent(Object.assign(new Event('keydown'), { key: 'Home' }))
    expect(ui.control('plot').attributes.get('aria-valuenow')).toBe('1')
    ui.control('plot').dispatchEvent(Object.assign(new Event('keydown'), { key: 'ArrowRight' }))
    expect(ui.control('plot').attributes.get('aria-valuenow')).toBe('2')
    expect(ui.requests).toHaveLength(1)
  })

  test('shows all registered sources with consumption values and exposes exact compact indicators to the keyboard', async () => {
    const ui = dashboardHarness()
    const active = { ...local, totals: { ...totals, input: 1200, output: 34 } }
    const archived = { ...local, id: '3f0ba490-10ed-4286-8e7a-4b8133ac7544', name: '历史来源', transport: 'legacy', freshness: 'historical' }
    const paused = { ...windows, id: '82a264b4-a051-4dde-9fdf-1ffe9f022ebc', name: '另一设备', freshness: 'paused' }
    await ui.reply(0, { range, sources: [archived, waiting, active, paused] })
    const { children: cards } = ui.control('source-cards')
    expect(cards).toHaveLength(4)
    expect(cards[0].children[0].textContent).toBe(local.name)
    expect(cards[0].children[2].textContent).toBe('2 次 · $0.001 已计价 · 1 条缺价')
    expect(cards.find(card => card.children[0].textContent === waiting.name)?.children[2].textContent).toBe('— 次 · — 已计价')
    const indicator = ui.control('kpi-tokens')
    expect(indicator).toMatchObject({ textContent: '1.3K', tabIndex: 0 })
    expect(indicator.attributes.get('role')).toBe('group')
    expect(indicator.attributes.get('aria-label')).toBe('Token 1,280')
    expect(indicator.attributes.get('data-exact')).toBe('Token 1,280')
    ui.click('layout-table')
    const [first] = ui.control('summary-rows').children
    expect(first.children).toHaveLength(8)
    first.children[0].children[0].dispatchEvent(new Event('click'))
    expect(ui.control('source').value).toBe('local')
    expect(ui.control('kpi-tokens').attributes.get('data-exact')).toBe('Token 1,234')
  })

  test('keeps the complete registration list when a source is selected and restores the scoped configuration return', async () => {
    const ui = dashboardHarness('?period=30d&via=conversation&secret=ignored')
    expect(ui.params(0)).toEqual({ period: '30d', via: 'conversation', bucket: 'day' })
    await ui.reply(0, { range, sources: [local, waiting] })
    ui.control('source-cards').children[0].children[0].dispatchEvent(new Event('click'))
    expect(ui.control('register-banner').hidden).toBe(true)
    expect(ui.control('source').value).toBe('local')
    expect(ui.control('kpi-tokens').textContent).toBe('23')
    expect(ui.control('source-cards').children).toHaveLength(1)
    ui.click('layout-table')
    ui.click('metric-calls')
    ui.control('model-rows').children[0].children[0].children[0].dispatchEvent(new Event('click'))
    const back = new URL(ui.control('settings').href, 'https://fixture.example/dashboard/').searchParams.get('back')!
    expect(Object.fromEntries(new URLSearchParams(back))).toEqual({ view: 'details', period: '30d', via: 'conversation',
      sourceId: 'local', model: '', layout: 'table', metric: 'calls' })
    expect(back).not.toContain('secret')
    expect(back).not.toContain(queryToken)
    const restored = dashboardHarness(back)
    await restored.reply(0, { range, sources: [local, waiting] })
    expect(restored.control('rows-section').hidden).toBe(false)
    expect(restored.control('model').value).toBe('model:')
    expect(restored.params(1)).toEqual({ from: range.from, to: range.to, sourceId: 'local', via: 'conversation', model: '' })
    restored.click('view-overview')
    expect(restored.control('source').value).toBe('local')
    expect(restored.control('sources-table').hidden).toBe(false)
    expect(restored.control('metric-calls').attributes.get('aria-pressed')).toBe('true')
    expect(restored.control('register-banner').hidden).toBe(true)
    restored.click('view-details')
    expect(restored.params(2)).toEqual(restored.params(1))
  })

  test('separates preparation, an empty published interval, and registration', async () => {
    const ui = dashboardHarness()
    expect(ui.control('loading').hidden).toBe(false)
    expect(ui.control('results').hidden).toBe(true)
    await ui.reply(0, { range, sources: [{ ...local, hasPublishedData: false, totals: empty, buckets: [], models: [] }] })
    expect(ui.control('register-banner').hidden).toBe(false)
    expect(ui.control('register').href.endsWith('#add')).toBe(true)
    expect(ui.control('usage-empty').textContent).toBe('用量准备中')
    expect(ui.control('kpi-tokens').textContent).toBe('—')
    expect(ui.control('billed').textContent).toBe('—')
    ui.click('refresh')
    await ui.reply(1, { range, sources: [{ ...local, totals: empty, models: [], buckets: [{ ...range, totals: empty }] }, waiting] })
    expect(ui.control('register-banner').hidden).toBe(true)
    expect(ui.control('usage-empty').textContent).toBe('此时段暂无用量')
    expect(ui.control('kpi-tokens').textContent).toBe('0')
    expect(ui.control('billed').textContent).toBe('$0.00 USD')
    expect(ui.control('source-cards').children).toHaveLength(2)
    ui.click('view-details')
    await ui.reply(2, { rows: [], nextPage: null })
    expect(ui.control('rows-notice').textContent).toBe('此时段暂无用量')
  })

  test('matches the model estimate and its unpriced count to filtered details', async () => {
    const ui = dashboardHarness('?via=conversation')
    const priced = { ...empty, calls: 1, input: 80, output: 10, cost: 0.25 }
    const nonpriced = { ...empty, calls: 2, input: 40, cacheRead: 11, unpriced: 1 }
    const other = { ...empty, calls: 2, input: 5, cost: 0.5, unpriced: 1 }
    await ui.reply(0, { range, sources: [
      { ...local, totals: { ...priced, calls: 3, input: 85, cost: 0.75, unpriced: 1 }, models: [{ model: 'target', totals: priced }, { model: 'other', totals: other }] },
      { ...windows, totals: nonpriced, models: [{ model: 'target', totals: nonpriced }] },
    ] })
    expect(ui.control('billed').textContent).toBe('$0.75 USD')
    expect(ui.control('unpriced').textContent).toBe('缺价 2 条')
    const [first] = ui.control('model-rows').children
    expect(first.children[0].children[0].textContent).toBe('target')
    expect(first.children[1].textContent).toBe('130')
    first.children[0].children[0].dispatchEvent(new Event('click'))
    expect(ui.control('model').value).toBe('model:target')
    expect(ui.params(1)).toEqual({ from: range.from, to: range.to, via: 'conversation', model: 'target' })
    expect(ui.control('billed').textContent).toBe('$0.25 USD')
    expect(ui.control('unpriced').textContent).toBe('缺价 1 条')
    await ui.reply(1, { rows: [
      { ...row, model: 'target', sourceId: 'local', via: 'direct', input: 80, output: 10, cacheRead: 0, cost: 0.25 },
      { ...row, model: 'target', cost: 0 },
      { ...row, model: 'target', input: 40, cacheRead: 0 },
    ], nextPage: null })
    expect(ui.control('detail-rows').children.map(detail => detail.children[7].textContent)).toEqual(['$0.25', '$0.00', '缺价'])
    ui.click('view-overview')
    expect(ui.control('billed').textContent).toBe('$0.75 USD')
    ui.click('view-details')
    expect(ui.control('billed').textContent).toBe('$0.25 USD')
    expect(ui.requests).toHaveLength(2)
    ui.change('model', '')
    expect(ui.control('billed').textContent).toBe('$0.75 USD')
    expect(ui.params(2)).not.toHaveProperty('model')
  })

  test('drills down to the unlabelled model and pins paging to the same source, scope and instant range', async () => {
    const ui = dashboardHarness()
    await ui.reply(0, { range, sources: [local, windows] })
    ui.change('source', windows.id)
    ui.control('model-rows').children[0].children[0].children[0].dispatchEvent(new Event('click'))
    expect(ui.requests[1].path.startsWith('../api/usage/rows?')).toBe(true)
    expect(ui.control('rows-section').hidden).toBe(false)
    const filters = { from: range.from, to: range.to, sourceId: windows.id, via: 'through', model: '' }
    expect(ui.params(1)).toEqual(filters)
    await ui.reply(1, { rows: [row], nextPage: 'fixture-next-page' })
    const detail = ui.control('detail-rows').children[0]
    expect(detail.children[0].children[0].dateTime).toBe(row.t)
    expect(detail.children[1].textContent).toBe(windows.name)
    expect(detail.children[3].textContent).toBe('OTLP 会话')
    expect(detail.children[5].children[0].textContent).toBe('缓存计数未知')
    expect(detail.children[7].textContent).toBe('缺价')
    ui.click('next-rows')
    expect(ui.params(2)).toEqual({ ...filters, page: 'fixture-next-page' })
    await ui.reply(2, { error: { code: 'invalid_page' } }, 400)
    expect(ui.params(3)).toEqual(filters)
    await ui.reply(3, { rows: [row], nextPage: 'new-page' })
    ui.click('next-rows')
    await ui.reply(4, { rows: [row], nextPage: null })
    expect(ui.control('current-page').textContent).toBe('第 2 页')
    ui.click('previous-rows')
    expect(ui.params(5)).toEqual(filters)
    ui.change('source', 'local')
    expect(ui.requests[5].init.signal?.aborted).toBe(true)
    await ui.reply(6, { rows: [{ ...row, sourceId: local.id, via: 'through', handedOn: true, cost: 0.125 }], nextPage: null })
    await ui.reply(5, { rows: [row], nextPage: null })
    const native = ui.control('detail-rows').children[0]
    expect(native.children[3].children[0].textContent).toBe('中间尝试')
    expect(native.children[7].textContent).toBe('—')
  })

  test('validates custom timestamps and uses the full summary when the trend range exceeds its limit', async () => {
    const ui = dashboardHarness()
    await ui.reply(0, { range, sources: [local] })
    ui.click('period-custom')
    ui.control('from').value = '2026-02-30T00:00:00Z'
    ui.control('custom-range').dispatchEvent(new Event('submit', { cancelable: true }))
    expect(ui.control('range-error').textContent).toContain('有效起止')
    expect(ui.requests).toHaveLength(1)
    ui.control('from').value = '2024-01-01T08:00:00+08:00'
    ui.control('custom-range').dispatchEvent(new Event('submit', { cancelable: true }))
    expect(ui.params(1)).toEqual({ from: '2024-01-01T08:00:00+08:00', to: range.to, bucket: 'day', via: 'through' })
    await ui.reply(1, { error: { code: 'bucket_range_too_large' } }, 400)
    expect(ui.params(2)).not.toHaveProperty('bucket')
    await ui.reply(2, { range, sources: [{ ...local, buckets: [] }] })
    expect(ui.control('trend-empty').textContent).toContain('上限')
    expect(ui.control('kpi-tokens').textContent).toBe('23')
    expect(ui.requests).toHaveLength(3)
  })

  test('keeps only the latest summary and rejects late rows from a changed scope', async () => {
    const ui = dashboardHarness()
    ui.click('period-30d')
    ui.click('period-today')
    expect(ui.requests[0].init.signal?.aborted).toBe(true)
    ui.requests[0].pending.reject(new Error('synthetic late failure'))
    await Bun.sleep(0)
    expect(ui.control('results').attributes.get('aria-busy')).toBe('true')
    expect(ui.params(2)).toEqual({ via: 'through', period: 'today', bucket: 'hour' })
    await ui.reply(2, { range, sources: [{ ...local, name: '今日结果' }] })
    await ui.reply(1, { range, sources: [{ ...local, name: '迟到结果' }] })
    expect(ui.control('summary-rows').children[0].children[0].children[0].textContent).toBe('今日结果')
    expect(ui.control('results').attributes.get('aria-busy')).toBe('false')
    ui.click('view-details')
    expect(ui.params(3)).toEqual({ from: range.from, to: range.to, via: 'through' })
    ui.change('via', 'all')
    expect(ui.params(4)).not.toHaveProperty('via')
    expect(ui.requests[3].init.signal?.aborted).toBe(true)
    await ui.reply(3, { rows: [row], nextPage: null })
    expect(ui.control('detail-rows').children).toHaveLength(0)
    await ui.reply(4, {}, 503)
    expect(ui.control('results').hidden).toBe(true)
    expect(ui.control('billing').hidden).toBe(true)
    expect(ui.control('retry').hidden).toBe(false)
    ui.click('retry')
    const newRange = { ...range, to: '2026-11-27T02:30:00.000Z' }
    await ui.reply(5, { range: newRange, sources: [local] })
    expect(ui.params(6)).toEqual({ from: newRange.from, to: newRange.to })
    await ui.reply(6, { rows: [{ ...row, sourceId: local.id }], nextPage: 'next' })
    ui.click('next-rows')
    ui.click('view-overview')
    ui.click('view-details')
    await ui.reply(7, { rows: [], nextPage: null })
    expect(ui.control('rows-notice').textContent).toBe('')
    expect(ui.control('detail-rows').children).toHaveLength(1)
    expect(ui.control('current-page').textContent).toBe('第 1 页')
  })

  test('retains the successful read time separately from yesterday’s interval on refresh failure', async () => {
    const yesterday = { ...range, from: '2026-11-26T00:00:00.000Z', to: '2026-11-26T02:00:00.000Z' }
    const ui = dashboardHarness(`?${new URLSearchParams({ period: 'custom', from: yesterday.from, to: yesterday.to })}`)
    await ui.reply(0, { range: yesterday, sources: [{ ...local, buckets: [] }] })
    expect(ui.control('read-at').dateTime).toBe(observedAt)
    const originalRange = ui.control('range-label').textContent
    expect(originalRange).toContain('2026/11/26')
    expect(ui.control('read-at').textContent).toContain('2026/11/27')
    const later = '2026-11-27T11:00:00.000Z'
    ui.setClock(later)
    ui.click('refresh')
    await ui.reply(1, {}, 503)
    expect(ui.control('results').hidden).toBe(false)
    expect(ui.control('notice').textContent).toContain('上次成功读取')
    expect(ui.control('kpi-tokens').textContent).toBe('23')
    expect(ui.control('range-label').textContent).toBe(originalRange)
    expect(ui.control('read-at').dateTime).toBe(observedAt)
    ui.click('retry')
    await ui.reply(2, { range: yesterday, sources: [{ ...local, buckets: [] }] })
    expect(ui.control('notice').textContent).toBe('')
    expect(ui.control('read-at').dateTime).toBe(later)
    expect(ui.control('range-label').textContent).toBe(originalRange)
  })

  test('bounds automatic startup retries and offers page reload for expired credentials on either endpoint', async () => {
    const ui = dashboardHarness('?view=details')
    for (let attempt = 0; attempt < 3; attempt++) {
      await ui.reply(attempt, {}, 503)
      expect(ui.timers.size).toBe(1)
      for (const timer of [...ui.timers.values()]) timer()
    }
    await ui.reply(3, {}, 503)
    expect(ui.timers.size).toBe(0)
    ui.click('retry')
    await ui.reply(4, {}, 403)
    expect(ui.control('reload').hidden).toBe(false)
    ui.click('reload')
    expect(ui.location.reloads).toBe(1)
    ui.click('refresh')
    await ui.reply(5, { range, sources: [local] })
    await ui.reply(6, {}, 403)
    expect(ui.control('rows-reload').hidden).toBe(false)
    ui.click('rows-reload')
    expect(ui.location.reloads).toBe(2)
  })
})

describe('diagnostic page', () => {
  const window = { usageHubHost: { backSearch: () => '?view=details' } }
  test('shows whether the service has adopted the saved Options revision', async () => {
    const { control, document } = documentHarness()
    const revision = '11111111-1111-4111-8111-111111111111'
    let ready = false
    runInNewContext(`${options}\n${diagnostics}`, { document, window, AbortSignal, URLSearchParams, setInterval: () => 1,
      location: { hash: `#revision=${revision}` }, fetch: async () => Response.json({ schema: 'magpie-usage-hub/status-v1', role: 'center', ready,
        phase: ready ? 'ready' : 'starting', receiver: 'off', loadedRevision: revision, appliedRevision: ready ? revision : null }) })
    await Bun.sleep(0)
    expect(control('notice').textContent).toContain('等待后台采用')
    ready = true
    control('refresh').dispatchEvent(new Event('click'))
    await Bun.sleep(0)
    expect(control('applied-revision').textContent).toBe(revision)
    expect(control('dashboard-link').href).toBe('../dashboard/?view=details')
    expect(control('dashboard-link').hidden).toBe(false)
  })

  test('shows center retry guidance and the next retry time', async () => {
    const { control, document } = documentHarness()
    runInNewContext(`${options}\n${diagnostics}`, { document, window, AbortSignal, URLSearchParams, setInterval: () => 1, location: { hash: '' },
      fetch: async () => Response.json({ schema: 'magpie-usage-hub/status-v1', role: 'center', ready: false,
        phase: 'retrying', retryAt: observedAt, failure: { stage: 'center', code: 'timeout' } }) })
    await Bun.sleep(0)
    expect(control('runtime-heading').textContent).toBe('中心服务')
    expect(control('phase').textContent).toBe('等待重试')
    expect(control('failure').textContent).toContain('核对中心本机网关')
    expect(control('retry-row').hidden).toBe(false)
    expect(control('dashboard-link').hidden).toBe(true)
  })
})
