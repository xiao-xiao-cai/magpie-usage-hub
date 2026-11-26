import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { createDiagnostics, serveDiagnostics, updateDiagnosticProgress } from '../../src/diagnostics.ts'
import { requestDirect } from '../../src/gateway/direct.ts'
import type { SyncState } from '../../src/state/store.ts'

const revision = 'b02166b2-07f4-4208-aa01-8dfb9acf244e'
const from = '2026-02-01T01:00:00.000Z'
const to = '2026-02-01T02:00:00.000Z'
const binding = {
  sourceGatewayUrl: 'http://127.0.0.1:7000/',
  sourceCallerKeyId: 'fixture-caller-id',
  centralGatewayUrl: 'https://fixture-private-center.example/',
  initialMode: 'now',
} as const

test('the loopback status service exposes a read-only summary of committed recovery progress', async () => {
  const diagnostics = createDiagnostics(revision, true)
  const state: SyncState = {
    version: 2,
    sourceInstanceId: 'd71370b8-945f-4042-8ae6-ef2364e75d0c',
    binding,
    cursor: 'fixture-daily-cursor',
    lastConfirmedAt: from,
    recovery: {
      active: {
        request: { id: 'bc2d5f3c-8157-474c-ab9e-15f3c08403ce', binding, kind: 'range', from, to },
        cursor: 'fixture-scan-cursor', pages: 2, accepted: 3, skipped: 1, lastConfirmedAt: to,
      },
      results: [],
    },
  }
  diagnostics.update({ phase: 'retrying', appliedRevision: revision,
    failure: { stage: 'center', code: 'upstream_failure', httpStatus: 503 },
    lastPage: { kind: 'recovery', accepted: 2, skipped: 1, hasMore: true },
  })
  updateDiagnosticProgress(diagnostics, state)
  const server = serveDiagnostics(diagnostics, 0)
  try {
    const page = await fetch(server.url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('用量同步诊断')
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'")
    const url = new URL('api/status', server.url)
    const response = await fetch(url, { headers: { Origin: 'null' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('null')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const serialized = await response.text()
    expect(JSON.parse(serialized)).toMatchObject({
      loadedRevision: revision, appliedRevision: revision, credentialConfigured: true,
      lastConfirmedAt: to, failure: { stage: 'center', code: 'upstream_failure', httpStatus: 503 },
      recovery: { status: 'running', kind: 'range', pages: 2, accepted: 3, skipped: 1, from, to },
    })
    for (const secret of ['fixture-', state.sourceInstanceId, state.recovery?.active?.request.id]) {
      if (secret) expect(serialized).not.toContain(secret)
    }
    const write = await fetch(url, { method: 'POST' })
    expect(write.status).toBe(405)
    expect(write.headers.get('allow')).toBe('GET')
    expect((await fetch(url, { headers: { Origin: 'https://fixture-unrelated.example' } })).status).toBe(403)
    expect((await fetch(new URL('state.json', server.url))).status).toBe(404)
  } finally {
    await server.stop(true)
  }
})

test('the center dashboard serves relative assets and read-only usage on loopback', async () => {
  const queried: string[] = []
  const server = serveDiagnostics(createDiagnostics(revision, true), 0, async url => {
    const period = url.searchParams.get('period')
    queried.push(`${url.pathname}:${period}`)
    if (period === 'fail') throw new Error('fixture private error')
    return Response.json({ period })
  })
  function read(path: URL, init: Partial<Parameters<typeof requestDirect>[1]> = {}) {
    return requestDirect(path, { method: 'GET', ...init }, AbortSignal.timeout(1_000))
  }
  try {
    expect(server.url.hostname).toBe('127.0.0.1')
    const dashboard = new URL('dashboard/', server.url)
    const page = await read(dashboard)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const csp = page.headers.get('content-security-policy')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("script-src 'self'")
    const html = await page.text()
    expect(html).toContain('href="dashboard.css"')
    expect(html).toContain('src="dashboard.js"')
    for (const [asset, mime, marker] of [
      ['dashboard.css', 'text/css', '.summary'], ['dashboard.js', 'text/javascript', '../api/usage'],
    ]) {
      const response = await read(new URL(asset, dashboard))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain(mime)
      expect(await response.text()).toContain(marker)
    }

    const api = new URL('../api/usage?period=7d', dashboard)
    const response = await read(api, { headers: { Origin: 'null' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('null')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ period: '7d' })
    const post = await read(api, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET')
    const foreign = await read(api, { headers: { Origin: 'https://fixture-unrelated.example' } })
    expect(foreign.status).toBe(403)
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull()
    expect((await read(api, { headers: { Host: 'fixture-unrelated.example' } })).status).toBe(403)
    const unavailable = await read(new URL('../api/usage?period=fail', dashboard))
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ error: { code: 'dashboard_unavailable' } })
    expect(queried).toEqual(['/api/usage:7d', '/api/usage:fail'])
  } finally {
    await server.stop(true)
  }
})

test('source diagnostics do not expose the center dashboard or usage API', async () => {
  const server = serveDiagnostics(createDiagnostics(revision, true), 0)
  try {
    for (const path of ['dashboard/', 'dashboard/dashboard.css', 'dashboard/dashboard.js', 'api/usage']) {
      const response = await requestDirect(new URL(path, server.url), { method: 'GET' }, AbortSignal.timeout(1_000))
      expect(response.status).toBe(404)
    }
  } finally {
    await server.stop(true)
  }
})

test('source management requires the token delivered with the protected management page', async () => {
  const mutations: unknown[] = []
  const server = serveDiagnostics(createDiagnostics(revision, false), 0, undefined, async request => {
    mutations.push(await request.json())
    return Response.json({ saved: true }, { status: 201 })
  })
  const endpoint = new URL('api/sources', server.url)
  const request = (headers: Record<string, string>, method = 'POST') => fetch(endpoint, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: '{"name":"fixture"}' } : {}),
  })
  try {
    const page = await fetch(new URL('sources/', server.url))
    expect(page.status).toBe(200)
    expect(page.headers.get('access-control-allow-origin')).toBeNull()
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
    const token = /name="usage-admin-token" content="([a-f0-9]{64})"/.exec(await page.text())?.[1]
    if (!token) throw new Error('management page did not provide a fixture token')

    const preflight = await request({ Origin: 'null', 'Access-Control-Request-Method': 'POST' }, 'OPTIONS')
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Magpie-Usage-Admin')
    expect((await request({ Origin: 'null' })).status).toBe(403)
    expect((await request({ Origin: 'https://fixture-unrelated.example', 'X-Magpie-Usage-Admin': token })).status).toBe(403)
    expect(mutations).toEqual([])
    const saved = await request({ Origin: 'null', 'X-Magpie-Usage-Admin': token })
    expect(saved.status).toBe(201)
    expect(saved.headers.get('cache-control')).toBe('no-store')
    expect(mutations).toEqual([{ name: 'fixture' }])
  } finally {
    await server.stop(true)
  }
})

test('diagnostic refresh ignores stale failures and hides status from a different revision', async () => {
  const elements = new Map<string, { textContent: string; hidden: boolean }>()
  const requests: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  let refresh: (() => Promise<void>) | undefined
  const status = createDiagnostics(revision, false)
  status.update({ phase: 'idle', appliedRevision: revision })
  runInNewContext(await Bun.file(new URL('../../ui/status.js', import.meta.url)).text(), {
    document: {
      getElementById(id: string) {
        const cached = elements.get(id)
        if (cached) return cached
        const element = {
          textContent: '', hidden: false,
          addEventListener(_event: string, callback: () => Promise<void>) { refresh = callback },
        }
        elements.set(id, element)
        return element
      },
    },
    fetch() {
      const request = Promise.withResolvers<Response>()
      requests.push(request)
      return request.promise
    },
    location: { hash: `#revision=${revision}` },
    setInterval() {},
    AbortSignal,
    URLSearchParams,
  })
  if (!refresh) throw new Error('refresh handler not installed')
  const earlier = refresh()
  const latest = refresh()
  requests[1].reject(new Error('fixture error'))
  await earlier
  expect(elements.get('notice')?.textContent).toBe('正在读取后台状态…')
  requests[2].resolve(Response.json(status.getStatus()))
  await latest
  requests[0].reject(new Error('fixture error'))
  await Bun.sleep(0)
  expect(elements.get('notice')?.textContent).toBe('后台已采用从配置页打开时的修订。')
  expect(elements.get('status')?.hidden).toBe(false)

  const differentRevision = refresh()
  const differentStatus = createDiagnostics('5c8f1dab-d60a-4325-a95d-695559540b9a', true)
  differentStatus.update({ phase: 'blocked' })
  requests[3].resolve(Response.json(differentStatus.getStatus()))
  await differentRevision
  expect(elements.get('status')?.hidden).toBe(true)
  expect(elements.get('notice')?.textContent).toContain('与配置页保存修订一致')
  expect(elements.get('phase')?.textContent).toBe('等待下次轮询')
})
