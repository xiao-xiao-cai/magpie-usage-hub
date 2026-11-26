import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { createDashboard } from '../../src/center/dashboard.ts'
import { createSourceTable } from '../../src/center/sources.ts'

const sourceA = 'd71370b8-945f-4042-8ae6-ef2364e75d0c'
const sourceB = 'b02166b2-07f4-4208-aa01-8dfb9acf244e'
const boundary = '2026-11-26T00:00:00+01:00'
const since = '2026-11-25T23:00:00.000Z'
const callTime = '2026-11-26T00:05:00.123456789Z'
const hiddenFields = {
  id: 'fixture-row-id-private', providerAccount: 'fixture-account-private', session: 'fixture-session-private',
  callerKeyId: 'fixture-caller-private', err: 'fixture-error-private',
}

function createFixtureLedger() {
  const database = new Database(':memory:', { strict: true })
  database.exec('CREATE TABLE usage_reports (rid TEXT PRIMARY KEY, source_instance_id TEXT, called_at_ms INTEGER, row_json TEXT)')
  createSourceTable(database)
  return database
}

function insertFixture(database: Database, sourceId: string, index: number, time: string, cost?: number) {
  const rid = `mpu1.${sourceId}.${index.toString(16).padStart(64, '0')}`
  database.query('INSERT INTO usage_reports VALUES (?, ?, ?, ?)').run(rid, sourceId, Date.parse(time), JSON.stringify({
    ...hiddenFields, rid, t: time, provider: 'fixture-provider', model: 'fixture-model', status: 200,
    in: 5, out: 2, cache_read: 7, cache_write: 3, cost,
  }))
  return rid
}

function nativeFixture(url: URL, start = boundary) {
  const category = url.searchParams.get('via')
  const isDirect = category === 'direct'
  const total = 1
  const offset = Math.min(Number(url.searchParams.get('offset')), total)
  const row = {
    ...hiddenFields, t: callTime, provider: isDirect ? '' : 'fixture-provider', model: 'fixture-model',
    status: isDirect ? 0 : 200, in: 10, out: 4, cache_read: 1, cache_write: 2,
    priced: !isDirect, cost: 0,
  }
  return Response.json({
    period: url.searchParams.get('period'), offset, total, rows: offset === 0 ? [row] : [],
    series: [{ time: start }],
    through: { calls: 0, input: 10, output: 4, cache_read: 1, cache_write: 2, cost: 0, unpriced: 0 },
    direct: { calls: 1, input: 10, output: 4, cache_read: 1, cache_write: 2, cost: 0, unpriced: 1 },
    reported: { calls: 99, input: 9_999, output: 9_999, cost: 900, unpriced: 0 },
  })
}

function search(search = '') {
  return new URL(`/api/usage${search}`, 'http://127.0.0.1')
}

test('dashboard merges each ledger once, counts attempts, and uses the native period boundary', async () => {
  const database = createFixtureLedger()
  const zero = insertFixture(database, sourceA, 1, since, 0)
  insertFixture(database, sourceA, 2, '2026-11-25T22:59:59.999Z', 5)
  const missing = insertFixture(database, sourceB, 3, callTime)
  const calls: { path: string; query: URLSearchParams; authorization: string | null }[] = []
  const native = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url)
    calls.push({ path: url.pathname, query: url.searchParams, authorization: request.headers.get('authorization') })
    return nativeFixture(url)
  } })
  try {
    const query = createDashboard(database, native.url, 1_000)
    const response = await query(search())
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({
      schema: 'magpie-usage-hub/usage-v1', period: '7d', window: { basis: 'native', since },
      totals: {
        local: { attempts: 2, input: 20, output: 8, cost: 0, unpriced: 1 },
        hub: { attempts: 2, input: 10, output: 4, cost: 0, unpriced: 1 },
        combined: { attempts: 4, input: 30, output: 12, cacheRead: 16, cacheWrite: 10, cost: 0, unpriced: 2 },
      },
      sources: [{ id: sourceB, totals: { attempts: 1, unpriced: 1 } }, { id: sourceA, totals: { attempts: 1, unpriced: 0 } }],
      detail: { scope: 'through', offset: 0, limit: 25, total: 1, rows: [{ time: callTime, status: 200, cost: 0 }] },
    })
    expect(text).not.toContain('-private')
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.path).toBe('/v1/magpie/usage/requests')
      expect(call.query.get('computer')).toBe('this')
      expect(call.query.get('period')).toBe('7d')
      expect(call.query.get('limit')).toBe(call.query.get('via') === 'through' ? '25' : '1')
      expect(call.authorization).toBeNull()
    }

    const reportedText = await (await query(search('?period=30d&scope=reported'))).text()
    expect(reportedText).not.toContain('-private')
    expect(JSON.parse(reportedText)).toMatchObject({ period: '30d', detail: {
      total: 2, rows: [{ rid: missing, sourceInstanceId: sourceB, time: callTime, cost: null },
        { rid: zero, sourceInstanceId: sourceA, time: since, cost: 0 }],
    } })
    const direct = await (await query(search('?period=today&scope=direct'))).json()
    expect(direct).toMatchObject({ period: 'today', detail: { rows: [{ status: null, provider: '', cost: null }] } })
  } finally {
    await native.stop(true)
    database.close()
  }
})

test('dashboard paginates a source and clamps offsets after data changes', async () => {
  const database = createFixtureLedger()
  for (let index = 0; index < 26; index += 1) insertFixture(database, sourceA, index, callTime, 0.02)
  insertFixture(database, sourceB, 27, callTime)
  const native = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => nativeFixture(new URL(request.url)) })
  try {
    const query = createDashboard(database, native.url, 1_000)
    const first = await (await query(search(`?scope=${sourceA}`))).json()
    expect(first.detail.rows).toHaveLength(25)
    expect(first.detail.rows.every((row: { sourceInstanceId: string }) => row.sourceInstanceId === sourceA)).toBe(true)
    const second = await (await query(search(`?scope=${sourceA}&offset=25`))).json()
    expect(second.detail).toMatchObject({ total: 26, offset: 25, rows: [{ rid: `mpu1.${sourceA}.${'0'.repeat(64)}` }] })
    expect(second.detail.rows).toHaveLength(1)
    expect(second.totals.hub.cost).toBeCloseTo(0.52, 10)
    const beyond = await (await query(search(`?scope=${sourceA}&offset=50`))).json()
    expect(beyond.detail).toMatchObject({ total: 26, offset: 26, rows: [] })
    expect((await query(search('?period=all'))).status).toBe(400)
    expect((await query(search('?scope=unknown'))).status).toBe(400)
    expect((await query(search('?offset=-1'))).status).toBe(400)
  } finally {
    await native.stop(true)
    database.close()
  }
})

test('a ledger failure or inconsistent boundary never produces a partial combined total', async () => {
  const database = createFixtureLedger()
  insertFixture(database, sourceA, 1, new Date().toISOString(), 0)
  let mode: 'ok' | 'fail' | 'redirect' | 'mismatch' = 'ok'
  let redirectedCalls = 0
  const native = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/redirected') {
      redirectedCalls += 1
      return nativeFixture(url)
    }
    if (mode === 'redirect' && url.searchParams.get('via') === 'direct') return Response.redirect(new URL('/redirected', url))
    if (mode === 'fail') return new Response('fixture-error-private', { status: 503 })
    return nativeFixture(url, mode === 'mismatch' && url.searchParams.get('via') === 'direct'
      ? '2026-11-27T00:00:00+01:00' : boundary)
  } })
  try {
    const query = createDashboard(database, native.url, 1_000)
    mode = 'fail'
    const body = await (await query(search('?scope=reported'))).text()
    expect(body).not.toContain('fixture-error-private')
    expect(JSON.parse(body)).toMatchObject({
      window: { basis: 'local_calendar' }, totals: { local: null, through: null, direct: null, combined: null, hub: { attempts: 1 } },
      detail: { total: 1 },
    })
    for (const failure of ['redirect', 'mismatch'] as const) {
      mode = failure
      expect(await (await query(search('?scope=direct'))).json()).toMatchObject({
        window: { basis: 'native', since }, totals: { local: null, direct: null, combined: null, through: { attempts: 1 } }, detail: null,
      })
    }
    expect(redirectedCalls).toBe(0)

    mode = 'ok'
    database.close()
    for (const nativeOnly of [query, createDashboard(null, native.url, 1_000)]) {
      expect(await (await nativeOnly(search())).json()).toMatchObject({
        totals: { local: { attempts: 2 }, hub: null, combined: null }, sources: null, detail: { total: 1 },
      })
    }
  } finally {
    await native.stop(true)
    database.close()
  }
})

test('native dashboard queries stay on the configured loopback with an HTTP proxy set', async () => {
  let proxyRequests = 0
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    proxyRequests += 1
    return new Response('fixture proxy')
  } })
  const native = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => nativeFixture(new URL(request.url)) })
  try {
    const source = new URL('../../src/center/dashboard.ts', import.meta.url).href
    const program = `
      import { createDashboard } from ${JSON.stringify(source)}
      const url = new URL(${JSON.stringify(native.url.href)})
      const probe = await fetch(url, { signal: AbortSignal.timeout(1000) })
      const query = createDashboard(null, url, 1000)
      const response = await query(new URL('/api/usage', url))
      console.log(JSON.stringify({ probe: await probe.text(), usage: await response.json() }))
    `
    const env = { ...process.env, HTTP_PROXY: proxy.url.href, http_proxy: proxy.url.href, NO_PROXY: '', no_proxy: '' }
    const child = Bun.spawn([process.execPath, '--eval', program], { env, stdout: 'pipe', stderr: 'ignore', timeout: 3_000 })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(JSON.parse(output)).toMatchObject({ probe: 'fixture proxy', usage: { totals: { local: { attempts: 2 } } } })
    expect(proxyRequests).toBe(1)
  } finally {
    await Promise.all([native.stop(true), proxy.stop(true)])
  }
})

class FixtureElement {
  textContent = ''
  value = ''
  hidden = false
  children: FixtureElement[] = []
  handlers = new Map<string, () => Promise<void>>()
  attributes = new Map<string, string>()
  addEventListener(event: string, handler: () => Promise<void>) { this.handlers.set(event, handler) }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) }
  append(element: FixtureElement) { this.children.push(element) }
  replaceChildren(...elements: FixtureElement[]) { this.children = elements }
}

test('dashboard UI keeps the latest page and renders priced zero and missing separately', async () => {
  const elements = new Map<string, FixtureElement>()
  function element(id: string) {
    if (!elements.has(id)) elements.set(id, new FixtureElement())
    return elements.get(id)!
  }
  element('period').value = '7d'
  element('scope').value = 'through'
  const requests: { url: string; signal: AbortSignal; pending: ReturnType<typeof Promise.withResolvers<Response>> }[] = []
  runInNewContext(await Bun.file(new URL('../../ui/dashboard/dashboard.js', import.meta.url)).text(), {
    document: { getElementById: element, createElement: () => new FixtureElement() },
    fetch(url: string, init: { signal: AbortSignal }) {
      const pending = Promise.withResolvers<Response>()
      requests.push({ url, signal: init.signal, pending })
      return pending.promise
    },
    AbortSignal, AbortController, URLSearchParams,
  })
  const refresh = element('refresh').handlers.get('click')!
  const earlier = refresh()
  element('scope').value = 'reported'
  const latest = element('scope').handlers.get('change')!()
  const row = { time: callTime, provider: 'fixture-provider', model: '<fixture-model>', status: 200, canceled: false,
    input: 5, output: 2, cacheRead: 7, cacheWrite: 3 }
  const totals = { attempts: 26, input: 5, output: 2, cacheRead: 7, cacheWrite: 3, cost: 0, unpriced: 1 }
  const result = {
    schema: 'magpie-usage-hub/usage-v1', period: '7d', window: { since, timeZone: 'UTC', basis: 'native' },
    totals: { local: null, through: null, direct: totals, hub: totals, combined: null }, sources: [{ id: sourceA, totals }],
    detail: { scope: 'reported', offset: 0, limit: 25, total: 26, rows: [
      { ...row, cost: 0 }, { ...row, cost: null }, ...Array.from({ length: 23 }, () => ({ ...row, cost: 0.02 })),
    ] },
  }
  expect(requests[0].signal.aborted).toBe(true)
  expect(requests[1].signal.aborted).toBe(true)
  expect(requests[2].url).toBe('../api/usage?period=7d&scope=reported&offset=0')
  requests[2].pending.resolve(Response.json(result))
  await latest
  requests[1].pending.resolve(Response.json({ ...result, detail: null }))
  await earlier
  requests[0].pending.reject(new Error('fixture stale failure'))
  await Bun.sleep(0)
  expect(element('notice').textContent).toContain('中心网关暂不可用，合计待确认')
  const rows = element('detail-rows').children
  expect(rows[0].children[1].children[0].textContent).toBe('<fixture-model>')
  expect(rows[0].children[5].textContent).toBe('0.00')
  expect(rows[1].children[5].textContent).toBe('缺价')
  expect(element('results').getAttribute('aria-busy')).toBe('false')

  const next = element('next').handlers.get('click')!()
  expect(requests[3].url).toBe('../api/usage?period=7d&scope=reported&offset=25')
  requests[3].pending.resolve(Response.json({ ...result, detail: { ...result.detail, offset: 25, rows: [{ ...row, cost: 0.02 }] } }))
  await next
  expect(element('page').textContent).toBe('26–26 / 26')
  expect(element('next').getAttribute('aria-disabled')).toBe('true')

  const fails = refresh()
  requests[4].pending.reject(new Error('fixture current failure'))
  await fails
  expect(element('notice').textContent).toContain('显示')
  expect(element('page').textContent).toBe('26–26 / 26')
})
