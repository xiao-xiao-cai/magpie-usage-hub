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
      phase: 'migration_required', ready: false, failure: null, lastAttemptAt: null, retryAt: null,
    })
    const write = await fetch(url, { method: 'POST' })
    expect(write.status).toBe(405)
    expect(write.headers.get('allow')).toBe('GET')
    expect((await fetch(url, { headers: { Origin: 'https://fixture-unrelated.example' } })).status).toBe(403)
    for (const path of ['dashboard/', 'api/usage', 'api/sources', 'pull/sources.json']) {
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

    const api = new URL('../api/usage?period=7d', dashboard)
    const response = await read(api, { headers: { Origin: 'null' } })
    expect(response.status).toBe(200)
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

test('source management and connection testing require the management page token', async () => {
  const invoked: string[] = []
  const server = serveDiagnostics(createDiagnostics(revision), 0, undefined, request => {
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

    for (const path of ['api/sources', 'api/sources/test']) {
      const preflight = await call(path, { Origin: 'null', 'Access-Control-Request-Method': 'POST' }, 'OPTIONS')
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Magpie-Usage-Admin')
      expect((await call(path, { Origin: 'null' })).status).toBe(403)
      expect((await call(path, { ...allowed, Origin: 'https://fixture-unrelated.example' })).status).toBe(403)
    }
    expect(invoked).toEqual([])
    for (const path of ['api/sources', 'api/sources/test']) {
      const saved = await call(path, allowed)
      expect(saved.status).toBe(201)
      expect(saved.headers.get('cache-control')).toBe('no-store')
    }
    expect((await call('api/sources/pairing', allowed)).status).toBe(405)
    expect(invoked).toEqual(['/api/sources', '/api/sources/test'])
  } finally {
    await server.stop(true)
  }
})
