import type { SyncState } from './state/store.ts'

export const diagnosticPort = 3493

type DiagnosticFailure = {
  stage: 'source' | 'center' | 'state' | 'mapping' | 'options' | 'run'
  code: string
  httpStatus?: number
}

type DiagnosticStatus = {
  schema: 'magpie-usage-hub/status-v1'
  loadedRevision: string | null
  appliedRevision: string | null
  phase: 'starting' | 'disabled' | 'waiting_lock' | 'syncing' | 'recovering' | 'idle' | 'retrying' | 'blocked'
  credentialConfigured: boolean
  lastAttemptAt: string | null
  lastConfirmedAt: string | null
  lastPage: { kind: 'sync' | 'recovery'; accepted: number; skipped: number; hasMore: boolean } | null
  retryAt: string | null
  failure: DiagnosticFailure | null
  recovery: {
    status: 'running' | 'complete' | 'failed' | 'rejected'
    kind: 'range' | 'cursor'
    from: string
    to: string | null
    pages: number
    accepted: number
    skipped: number
    failure: string | null
  } | null
}

type DiagnosticUpdate = Partial<Omit<DiagnosticStatus, 'schema' | 'loadedRevision' | 'credentialConfigured'>>

export function createDiagnostics(loadedRevision: string | null, credentialConfigured: boolean) {
  let status: DiagnosticStatus = {
    schema: 'magpie-usage-hub/status-v1',
    loadedRevision,
    credentialConfigured,
    appliedRevision: null,
    phase: 'starting',
    lastAttemptAt: null,
    lastConfirmedAt: null,
    lastPage: null,
    retryAt: null,
    failure: null,
    recovery: null,
  }
  return {
    getStatus: () => status,
    update(update: DiagnosticUpdate) {
      status = { ...status, ...update }
    },
  }
}

export type Diagnostics = ReturnType<typeof createDiagnostics>

export function updateDiagnosticProgress(diagnostics: Diagnostics, state: SyncState, requestId?: string): void {
  const history = state.recovery?.results ?? []
  const active = state.recovery?.active
  const selected = active ?? history.find(result => result.request.id === requestId) ?? history.at(-1)
  const lastRecovery = history.findLast(result => 'lastConfirmedAt' in result && result.lastConfirmedAt !== null)
  const lastRecoveryAt = lastRecovery && 'lastConfirmedAt' in lastRecovery ? lastRecovery.lastConfirmedAt : null
  const confirmedAt = [state.lastConfirmedAt, active?.lastConfirmedAt, lastRecoveryAt]
    .filter((timestamp): timestamp is string => typeof timestamp === 'string')
    .sort()
    .at(-1) ?? null
  const progress = selected && 'pages' in selected ? selected : null
  diagnostics.update({
    lastConfirmedAt: confirmedAt,
    recovery: selected ? {
      status: 'status' in selected ? selected.status : 'running',
      kind: selected.request.kind,
      from: selected.request.from,
      to: selected.request.kind === 'range' ? selected.request.to : null,
      pages: progress?.pages ?? 0,
      accepted: progress?.accepted ?? 0,
      skipped: progress?.skipped ?? 0,
      failure: 'reason' in selected ? selected.reason : null,
    } : null,
  })
}

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/status.js', ['status.js', 'text/javascript; charset=utf-8']],
  ['/status.css', ['status.css', 'text/css; charset=utf-8']],
])

export function serveDiagnostics(diagnostics: Diagnostics, port = diagnosticPort) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request, server) {
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
      if (request.method !== 'GET') {
        headers.set('Allow', 'GET')
        return new Response(null, { status: 405, headers })
      }

      const path = new URL(request.url).pathname
      if (path === '/api/status') return Response.json(diagnostics.getStatus(), { headers })
      const asset = assets.get(path)
      if (asset === undefined) return new Response(null, { status: 404, headers })
      const [file, mimeType] = asset
      headers.set('Content-Type', mimeType)
      return new Response(Bun.file(new URL(`../ui/${file}`, import.meta.url)), { headers })
    },
  })
}

export function startDiagnostics(diagnostics: Diagnostics): void {
  let reported = false
  function listen() {
    try {
      serveDiagnostics(diagnostics).unref()
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
