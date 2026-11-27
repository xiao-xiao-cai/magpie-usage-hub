import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { SyncPhase } from './sync/protocol.ts'

export const diagnosticPort = 3493

type DiagnosticFailure = {
  stage: 'source' | 'center' | 'state' | 'options'
  code: string
  httpStatus?: number
}

type DiagnosticStatus = {
  schema: 'magpie-usage-hub/status-v1'
  loadedRevision: string | null
  appliedRevision: string | null
  phase: 'starting' | 'disabled' | 'migration_required' | 'waiting_lock' | 'ready' | 'retrying' | 'blocked'
  role: 'center' | null
  syncPhase: SyncPhase | null
  ready: boolean
  receiver: 'off' | 'listening' | 'failed'
  collectorPhase: 'starting' | 'ready' | 'retrying' | 'blocked' | null
  collectorFailure: DiagnosticFailure | null
  collectorRetryAt: string | null
  hasMore: boolean
  lastPageAt: string | null
  lastSyncedAt: string | null
  lastAttemptAt: string | null
  retryAt: string | null
  failure: DiagnosticFailure | null
}

type DiagnosticUpdate = Partial<Omit<DiagnosticStatus, 'schema' | 'loadedRevision' | 'role'>>

export function createDiagnostics(loadedRevision: string | null, role: DiagnosticStatus['role'] = null) {
  let status: DiagnosticStatus = {
    schema: 'magpie-usage-hub/status-v1',
    loadedRevision,
    appliedRevision: null,
    phase: 'starting',
    role,
    syncPhase: null,
    ready: false,
    receiver: 'off',
    collectorPhase: null,
    collectorFailure: null,
    collectorRetryAt: null,
    hasMore: false,
    lastPageAt: null,
    lastSyncedAt: null,
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
  ['/entry.js', ['entry.js', 'text/javascript; charset=utf-8']],
  ['/options.js', ['../page/options.js', 'text/javascript; charset=utf-8']],
  ['/shared.css', ['shared.css', 'text/css; charset=utf-8']],
  ['/host.js', ['host.js', 'text/javascript; charset=utf-8']],
  ['/status/', ['index.html', 'text/html; charset=utf-8']],
  ['/status/status.js', ['status.js', 'text/javascript; charset=utf-8']],
  ['/status/status.css', ['status.css', 'text/css; charset=utf-8']],
])
const dashboardAssets = new Map([
  ['/dashboard/dashboard.js', ['dashboard/dashboard.js', 'text/javascript; charset=utf-8']],
  ['/dashboard/dashboard.css', ['dashboard/dashboard.css', 'text/css; charset=utf-8']],
])
const managementAssets = new Map([
  ['/sources/onboarding.js', ['sources/onboarding.js', 'text/javascript; charset=utf-8']],
  ['/sources/sources.js', ['sources/sources.js', 'text/javascript; charset=utf-8']],
  ['/sources/sources.css', ['sources/sources.css', 'text/css; charset=utf-8']],
])
const queryPaths = new Set(['/api/usage', '/api/usage/rows'])
const adminHeader = 'X-Magpie-Usage-Admin'
const queryHeader = 'X-Magpie-Usage-Query'
type DashboardQuery = (url: URL, signal: AbortSignal) => Promise<Response>
type ManageSources = (request: Request) => Response | Promise<Response>

function admits(request: Request, header: string, token: string) {
  const actual = Buffer.from(request.headers.get(header) ?? '', 'utf8')
  return actual.length === token.length && timingSafeEqual(actual, Buffer.from(token))
}

function preflight(headers: Headers, header: string, methods: string) {
  headers.set('Access-Control-Allow-Headers', header)
  headers.set('Access-Control-Allow-Methods', methods)
  return new Response(null, { status: 204, headers })
}

export function serveDiagnostics(
  diagnostics: Diagnostics, port = diagnosticPort, dashboard?: DashboardQuery, manage?: ManageSources,
) {
  const adminToken = manage ? randomBytes(32).toString('hex') : ''
  const queryToken = dashboard ? randomBytes(32).toString('hex') : ''
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
      if (manage && path === '/api/sources') {
        if (request.method === 'OPTIONS' && origin === 'null') {
          return preflight(headers, `Content-Type, ${adminHeader}`, 'GET, POST')
        }
        if (!admits(request, adminHeader, adminToken)) {
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
      if (dashboard && queryPaths.has(path) && request.method === 'OPTIONS' && origin === 'null') {
        return preflight(headers, queryHeader, 'GET')
      }
      if (request.method !== 'GET') {
        headers.set('Allow', 'GET')
        return new Response(null, { status: 405, headers })
      }

      if (path === '/') {
        headers.set('Content-Type', 'text/html; charset=utf-8')
        const template = await Bun.file(new URL('../ui/entry.html', import.meta.url)).text()
        return new Response(template.replace('__CENTER_AVAILABLE__', dashboard ? 'yes' : 'no'), { headers })
      }

      if ((manage && path === '/sources/') || (dashboard && path === '/dashboard/')) {
        headers.delete('Access-Control-Allow-Origin')
        headers.set('Content-Type', 'text/html; charset=utf-8')
        headers.set('Content-Security-Policy', `${headers.get('Content-Security-Policy')}; frame-ancestors 'self'`)
        const isDashboard = path === '/dashboard/'
        const template = await Bun.file(new URL(`../ui${path}index.html`, import.meta.url)).text()
        return new Response(isDashboard ? template.replace('__USAGE_QUERY_TOKEN__', queryToken)
          : template.replace('__USAGE_ADMIN_TOKEN__', adminToken), { headers })
      }
      if (path === '/api/status') return Response.json(diagnostics.getStatus(), { headers })
      if (dashboard && queryPaths.has(path)) {
        if (!admits(request, queryHeader, queryToken)) {
          return Response.json({ error: { code: 'query_token_invalid' } }, { status: 403, headers })
        }
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
