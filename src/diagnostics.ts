import { randomBytes, timingSafeEqual } from 'node:crypto'

export const diagnosticPort = 3493

type DiagnosticFailure = {
  stage: 'center' | 'state' | 'options'
  code: string
  httpStatus?: number
}

type DiagnosticStatus = {
  schema: 'magpie-usage-hub/status-v1'
  loadedRevision: string | null
  appliedRevision: string | null
  phase: 'starting' | 'disabled' | 'migration_required' | 'waiting_lock' | 'ready' | 'retrying' | 'blocked'
  ready: boolean
  lastAttemptAt: string | null
  retryAt: string | null
  failure: DiagnosticFailure | null
}

type DiagnosticUpdate = Partial<Omit<DiagnosticStatus, 'schema' | 'loadedRevision'>>

export function createDiagnostics(loadedRevision: string | null) {
  let status: DiagnosticStatus = {
    schema: 'magpie-usage-hub/status-v1',
    loadedRevision,
    appliedRevision: null,
    phase: 'starting',
    ready: false,
    lastAttemptAt: null,
    retryAt: null,
    failure: null,
  }
  return {
    getStatus: () => status,
    update(update: DiagnosticUpdate) {
      status = { ...status, ...update }
    },
  }
}

export type Diagnostics = ReturnType<typeof createDiagnostics>

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/status.js', ['status.js', 'text/javascript; charset=utf-8']],
  ['/status.css', ['status.css', 'text/css; charset=utf-8']],
])
const dashboardAssets = new Map([
  ['/dashboard/', ['dashboard/index.html', 'text/html; charset=utf-8']],
  ['/dashboard/dashboard.js', ['dashboard/dashboard.js', 'text/javascript; charset=utf-8']],
  ['/dashboard/dashboard.css', ['dashboard/dashboard.css', 'text/css; charset=utf-8']],
])
const managementAssets = new Map([
  ['/sources/sources.js', ['sources/sources.js', 'text/javascript; charset=utf-8']],
  ['/sources/sources.css', ['sources/sources.css', 'text/css; charset=utf-8']],
])
const managementPaths = new Set(['/api/sources', '/api/sources/test'])
const adminHeader = 'X-Magpie-Usage-Admin'
type DashboardQuery = (url: URL, signal: AbortSignal) => Promise<Response>
type ManageSources = (request: Request) => Response | Promise<Response>

export function serveDiagnostics(
  diagnostics: Diagnostics, port = diagnosticPort, dashboard?: DashboardQuery, manage?: ManageSources,
) {
  const adminToken = manage ? randomBytes(32).toString('hex') : ''
  const adminTokenBytes = Buffer.from(adminToken, 'utf8')
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    maxRequestBodySize: 16 * 1024,
    development: false,
    async fetch(request, server) {
      const headers = new Headers({
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      })
      const origin = request.headers.get('origin')
      if (request.headers.get('host') !== `127.0.0.1:${server.port}` || (origin !== null && origin !== 'null')) {
        return new Response(null, { status: 403, headers })
      }
      headers.set('Access-Control-Allow-Origin', 'null')
      const url = new URL(request.url)
      const path = url.pathname
      if (manage && managementPaths.has(path)) {
        if (request.method === 'OPTIONS' && origin === 'null') {
          headers.set('Access-Control-Allow-Headers', `Content-Type, ${adminHeader}`)
          headers.set('Access-Control-Allow-Methods', 'GET, POST')
          return new Response(null, { status: 204, headers })
        }
        const presented = Buffer.from(request.headers.get(adminHeader) ?? '', 'utf8')
        if (presented.length !== adminTokenBytes.length || !timingSafeEqual(presented, adminTokenBytes)) {
          return Response.json({ error: { code: 'admin_token_invalid' } }, { status: 403, headers })
        }
        try {
          const result = await manage(request)
          headers.set('Content-Type', 'application/json; charset=utf-8')
          const allow = result.headers.get('Allow')
          if (allow) headers.set('Allow', allow)
          return new Response(result.body, { status: result.status, headers })
        } catch {
          return Response.json({ error: { code: 'source_management_unavailable' } }, { status: 503, headers })
        }
      }
      if (request.method !== 'GET') {
        headers.set('Allow', 'GET')
        return new Response(null, { status: 405, headers })
      }

      if (manage && path === '/sources/') {
        headers.delete('Access-Control-Allow-Origin')
        headers.set('Content-Type', 'text/html; charset=utf-8')
        headers.set('Content-Security-Policy', `${headers.get('Content-Security-Policy')}; frame-ancestors 'self'`)
        const template = await Bun.file(new URL('../ui/sources/index.html', import.meta.url)).text()
        return new Response(template.replace('__USAGE_ADMIN_TOKEN__', adminToken), { headers })
      }
      if (path === '/api/status') return Response.json(diagnostics.getStatus(), { headers })
      if (dashboard && path === '/api/usage') {
        try {
          const result = await dashboard(url, request.signal)
          headers.set('Content-Type', 'application/json; charset=utf-8')
          return new Response(result.body, { status: result.status, headers })
        } catch {
          return Response.json({ error: { code: 'dashboard_unavailable' } }, { status: 503, headers })
        }
      }
      const asset = assets.get(path) ?? (dashboard ? dashboardAssets.get(path) : undefined)
        ?? (manage ? managementAssets.get(path) : undefined)
      if (asset === undefined) return new Response(null, { status: 404, headers })
      const [file, mimeType] = asset
      headers.set('Content-Type', mimeType)
      return new Response(Bun.file(new URL(`../ui/${file}`, import.meta.url)), { headers })
    },
  })
}

export function startDiagnostics(diagnostics: Diagnostics, dashboard?: DashboardQuery, manage?: ManageSources): void {
  let reported = false
  function listen() {
    try {
      serveDiagnostics(diagnostics, diagnosticPort, dashboard, manage).unref()
      if (reported) console.info('[magpie-usage-hub]', '{"status":"diagnostic_ready"}')
    } catch (error) {
      if (!reported) {
        const code = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
          ? 'diagnostic_port_in_use' : 'diagnostic_listener_unavailable'
        console.warn('[magpie-usage-hub]', JSON.stringify({ status: 'diagnostic_unavailable', code, port: diagnosticPort }))
        reported = true
      }
      setTimeout(listen, 1_000).unref()
    }
  }
  listen()
}
