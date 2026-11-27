import { expect, test } from 'bun:test'
import { createDiagnostics, serveDiagnostics } from '../../src/diagnostics.ts'
import { requestDirect } from '../../src/gateway/direct.ts'

const revision = 'b02166b2-07f4-4208-aa01-8dfb9acf244e'

test('loopback status only reports migration and ready diagnostics and rejects foreign origins', async () => {
  const diagnostics = createDiagnostics(revision)
  diagnostics.update({ phase: 'migration_required' })
  const server = serveDiagnostics(diagnostics, 0)
  try {
    const url = new URL('api/status', server.url)
    const response = await fetch(url, { headers: { Origin: 'null' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('null')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      schema: 'magpie-usage-hub/status-v1', loadedRevision: revision, appliedRevision: null,
      phase: 'migration_required', role: null, syncPhase: null, ready: false, receiver: 'off', hasMore: false,
      collectorPhase: null, collectorFailure: null, collectorRetryAt: null,
      failure: null, lastAttemptAt: null, retryAt: null, lastPageAt: null, lastSyncedAt: null,
    })
    const write = await fetch(url, { method: 'POST' })
    expect(write.status).toBe(405)
    expect(write.headers.get('allow')).toBe('GET')
    expect((await fetch(url, { headers: { Origin: 'https://fixture-unrelated.example' } })).status).toBe(403)
    const root = await fetch(server.url)
    expect(await root.text()).toContain('<meta name="center-available" content="no">')
    const options = await fetch(new URL('options.js', server.url), { headers: { Origin: 'null' } })
    expect(options.status).toBe(200)
    expect(options.headers.get('content-type')).toContain('text/javascript')
    expect(await options.text()).toBe(await Bun.file(new URL('../../page/options.js', import.meta.url)).text())
    const styles = await fetch(new URL('shared.css', server.url))
    expect(styles.status).toBe(200)
    expect(styles.headers.get('content-type')).toContain('text/css')
    expect(await styles.text()).toBe(await Bun.file(new URL('../../page/shared.css', import.meta.url)).text())
    for (const path of ['dashboard/', 'api/usage', 'api/usage/rows', 'api/sources', 'push/center.sqlite']) {
      expect((await fetch(new URL(path, server.url))).status).toBe(404)
    }
  } finally {
    await server.stop(true)
  }
})

test('the center dashboard serves relative assets and read-only usage on loopback', async () => {
  const queried: string[] = []
  const server = serveDiagnostics(createDiagnostics(revision), 0, async url => {
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
    const html = await page.text()
    expect(html).toContain('href="dashboard.css"')
    expect(html).toContain('src="dashboard.js"')
    for (const [asset, mime] of [['dashboard.css', 'text/css'], ['dashboard.js', 'text/javascript']]) {
      const response = await read(new URL(asset, dashboard))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain(mime)
      await response.text()
    }

    const token = /name="usage-query-token" content="([a-f0-9]{64})"/.exec(html)?.[1]
    if (!token) throw new Error('dashboard did not provide a fixture token')
    expect(page.headers.get('access-control-allow-origin')).toBeNull()
    const authorized = { Origin: 'null', 'X-Magpie-Usage-Query': token }
    const api = new URL('../api/usage?period=7d', dashboard)
    const details = new URL('../api/usage/rows?period=7d', dashboard)
    for (const endpoint of [api, details]) {
      const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'null' } })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-headers')).toBe('X-Magpie-Usage-Query')
      expect((await read(endpoint, { headers: { Origin: 'null' } })).status).toBe(403)
      expect((await read(endpoint, { headers: { 'X-Magpie-Usage-Admin': token } })).status).toBe(403)
    }
    const response = await read(api, { headers: authorized })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ period: '7d' })
    expect((await read(details, { headers: authorized })).status).toBe(200)
    const post = await read(api, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET')
    const foreign = await read(api, { headers: { Origin: 'https://fixture-unrelated.example' } })
    expect(foreign.status).toBe(403)
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull()
    expect((await read(api, { headers: { Host: 'fixture-unrelated.example' } })).status).toBe(403)
    const unavailable = await read(new URL('../api/usage?period=fail', dashboard), { headers: authorized })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ error: { code: 'dashboard_unavailable' } })
    expect(queried).toEqual(['/api/usage:7d', '/api/usage/rows:7d', '/api/usage:fail'])
  } finally {
    await server.stop(true)
  }
})

test('source management requires its management page token', async () => {
  const invoked: string[] = []
  const server = serveDiagnostics(createDiagnostics(revision), 0, async () => Response.json({ sources: [] }), request => {
    invoked.push(new URL(request.url).pathname)
    return Response.json({ saved: true }, { status: 201 })
  })
  const call = (path: string, headers: Record<string, string>, method = 'POST') => fetch(new URL(path, server.url), {
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
    const allowed = { Origin: 'null', 'X-Magpie-Usage-Admin': token }
    const html = await (await fetch(new URL('dashboard/', server.url))).text()
    const queryToken = /name="usage-query-token" content="([a-f0-9]{64})"/.exec(html)?.[1]
    if (!queryToken) throw new Error('dashboard did not provide a fixture token')
    expect(queryToken).not.toBe(token)
    expect((await call('api/sources', { Origin: 'null', 'X-Magpie-Usage-Admin': queryToken })).status).toBe(403)
    expect((await call('api/usage', { Origin: 'null', 'X-Magpie-Usage-Query': token }, 'GET')).status).toBe(403)
    const deviceAuth = { Origin: 'null', Authorization: `Bearer ${'a'.repeat(64)}` }
    expect((await call('api/sources', deviceAuth)).status).toBe(403)
    expect((await call('api/usage', deviceAuth, 'GET')).status).toBe(403)

    for (const path of ['api/sources']) {
      const preflight = await call(path, { Origin: 'null', 'Access-Control-Request-Method': 'POST' }, 'OPTIONS')
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Magpie-Usage-Admin')
      expect((await call(path, { Origin: 'null' })).status).toBe(403)
      expect((await call(path, { ...allowed, Origin: 'https://fixture-unrelated.example' })).status).toBe(403)
    }
    expect(invoked).toEqual([])
    const saved = await call('api/sources', allowed)
    expect(saved.status).toBe(201)
    expect(saved.headers.get('cache-control')).toBe('no-store')
    expect((await call('api/sources/pairing', allowed)).status).toBe(405)
    expect(invoked).toEqual(['/api/sources'])
  } finally {
    await server.stop(true)
  }
})
