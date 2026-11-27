import { expect, test } from 'bun:test'
import { createDashboard } from '../../src/center/dashboard.ts'

const dashboardUrl = new URL('http://127.0.0.1/api/usage')
const zero = { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, unpriced: 0 }
const meta = { rows: [{ t: '2000-01-01', account: 'fixture-account', rid: 'fixture-record' }], total: 100 }
const localSince = '2026-11-21T00:00:00Z'
const remoteSince = '2026-11-21T00:00:00+08:00'

test('one request per source combines native calls and tokens and retains separate native windows', async () => {
  const observed: { path: string; authorization: string | null }[] = []
  const gateway = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const authorization = request.headers.get('Authorization')
      observed.push({ path: url.pathname + url.search, authorization })
      const period = url.searchParams.get('period')
      if (authorization) return Response.json({
        ...meta, period, series: [{ time: remoteSince }], through: { ...zero, calls: 4, unpriced: 4 }, direct: zero,
        reported: [null],
      })
      return Response.json({
        ...meta, period, series: [{ time: localSince }],
        through: { calls: 3, input: 20, output: 10, cache_read: 8, cache_write: 6, cost: 0.25, unpriced: 1 },
        direct: { calls: 2, input: 4, output: 2, cache_read: 3, cache_write: 4, cost: 0.125, unpriced: 1 },
        reported: { ...zero, calls: 90 },
      })
    },
  })
  const remote = { name: 'Windows 合成来源', gatewayUrl: gateway.url.href, key: 'fixture-read-key', enabled: true }
  const dashboard = createDashboard(gateway.url, 1_000, () => [remote, { ...remote, name: '暂停', enabled: false }])
  try {
    const response = await dashboard(dashboardUrl)
    const serialized = await response.text()
    expect(JSON.parse(serialized)).toEqual({
      schema: 'magpie-usage-hub/usage-v2', period: '7d', sources: [
        { name: '中心本机', status: 'ok', since: localSince, checkedAt: expect.any(String), failure: null,
          totals: { calls: 5, input: 24, output: 12, cacheRead: 11, cacheWrite: 10, cost: 0.375, unpriced: 2 } },
        { name: remote.name, status: 'ok', since: remoteSince, checkedAt: expect.any(String), failure: null,
          totals: { calls: 4, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 4 } },
        { name: '暂停', status: 'paused', since: null, totals: null, checkedAt: null, failure: null },
      ],
    })
    const path = '/v1/magpie/usage/requests?computer=this&period=7d&offset=0&limit=1'
    expect(observed).toHaveLength(2)
    expect(observed).toContainEqual({ path, authorization: null })
    expect(observed).toContainEqual({ path, authorization: 'Bearer fixture-read-key' })
    expect(serialized).not.toContain('fixture-')
    expect(serialized).not.toContain(gateway.url.origin)
    expect((await dashboard(new URL('?period=all', dashboardUrl))).status).toBe(400)
    expect(observed).toHaveLength(2)
  } finally {
    await gateway.stop(true)
  }
})

test('sources isolate timeout, invalid data, redirect, authentication, and upstream failures', async () => {
  const outcomes = [
    ['401', 'unauthorized', 401], ['403', 'forbidden', 403], ['503', 'unavailable', 503], ['redirect', 'redirect', 302],
    ['slow', 'timeout'], ['json', 'incompatible_response'], ['period', 'incompatible_response'],
    ['fraction', 'incompatible_response'], ['cost', 'incompatible_response'], ['overflow', 'incompatible_response'],
    ['window', 'incompatible_response'], ['large', 'incompatible_response'],
  ] as const
  let redirected = 0
  const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { redirected++; return new Response() } })
  const gateway = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const credential = request.headers.get('authorization')?.slice('Bearer '.length)
      const payload = { period: '30d', through: zero, direct: zero, series: [] }
      if (credential === 'redirect') return Response.redirect(target.url, 302)
      if (credential === '401' || credential === '403' || credential === '503') {
        return new Response('fixture-sensitive-response', { status: Number(credential) })
      }
      if (credential === 'slow') {
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } }))
      }
      if (credential === 'json') return new Response('{"fixture-error"')
      if (credential === 'period') return Response.json({ ...payload, period: '7d' })
      if (credential === 'fraction') return Response.json({ ...payload, through: { ...zero, calls: 0.5 } })
      if (credential === 'cost') return Response.json({ ...payload, direct: { ...zero, cost: -1 } })
      if (credential === 'overflow') return Response.json({ ...payload, through: { ...zero, input: Number.MAX_SAFE_INTEGER },
        direct: { ...zero, input: 1 } })
      if (credential === 'window') return Response.json({ ...payload, series: [{ time: 'fixture-local-time' }] })
      if (credential === 'large') return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(600_000).fill(32))
          controller.enqueue(new Uint8Array(600_000).fill(32))
          controller.close()
        },
      }))
      return Response.json(payload)
    },
  })
  const dashboard = createDashboard(gateway.url, 200, () => outcomes.map(([name]) => ({
    name, gatewayUrl: gateway.url.href, key: name, enabled: true,
  })))
  try {
    const response = await dashboard(new URL('?period=30d', dashboardUrl))
    const serialized = await response.text()
    const { sources } = JSON.parse(serialized)
    expect(sources[0]).toMatchObject({ status: 'ok', since: null, totals: { calls: 0, cost: 0, unpriced: 0 } })
    expect(sources.slice(1)).toEqual(outcomes.map(([name, code, httpStatus]) => ({
      name, status: 'unavailable', checkedAt: expect.any(String), since: null, totals: null,
      failure: { code, ...(httpStatus === undefined ? {} : { httpStatus }) },
    })))
    expect(serialized).not.toContain('fixture-')
    expect(redirected).toBe(0)
  } finally {
    await Promise.all([gateway.stop(true), target.stop(true)])
  }
})

test('dashboard overlaps at most four sources in one refresh', async () => {
  let active = 0
  let peak = 0
  let requests = 0
  const gateway = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch() {
      requests++
      peak = Math.max(peak, ++active)
      await Bun.sleep(35)
      active--
      return Response.json({ period: 'today', since: '2026-11-27T00:00:00+02:00', through: zero, direct: zero })
    },
  })
  const dashboard = createDashboard(gateway.url, 1_000, () => Array.from({ length: 7 }, (_, index) => ({
    name: `来源 ${index}`, gatewayUrl: gateway.url.href, key: 'fixture-key', enabled: true,
  })))
  try {
    const response = await dashboard(new URL('?period=today', dashboardUrl))
    expect((await response.json()).sources).toHaveLength(8)
    expect(requests).toBe(8)
    expect(peak).toBe(4)
  } finally {
    await gateway.stop(true)
  }
})
