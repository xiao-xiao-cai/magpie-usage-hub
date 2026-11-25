const usageRequestsPath = '/v1/magpie/usage/requests'

type GatewayStage = 'source' | 'center'

type GatewayFailureCode =
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'redirect_refused'
  | 'unauthorized'
  | 'gateway_unavailable'
  | 'rate_limited'
  | 'upstream_failure'
  | 'batch_too_large'
  | 'cursor_invalid'
  | 'cursor_filter_changed'
  | 'cursor_reset'
  | 'cursor_expired'
  | 'invalid_response_json'
  | 'invalid_gateway_identity'
  | 'invalid_source_page'
  | 'invalid_batch'
  | 'invalid_receipt'

export class GatewayFailure extends Error {
  readonly stage: GatewayStage
  readonly code: GatewayFailureCode
  readonly httpStatus?: number
  readonly retryAfterMs?: number

  constructor(stage: GatewayStage, code: GatewayFailureCode, httpStatus?: number, retryAfterMs?: number) {
    super(code)
    this.name = 'GatewayFailure'
    this.stage = stage
    this.code = code
    if (httpStatus !== undefined) this.httpStatus = httpStatus
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

export type UsagePage = {
  rows: Record<string, unknown>[]
  deletedCount: number
  nextCursor: string
  hasMore: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readCursorFailure(payload: unknown, status: number): GatewayFailureCode {
  if (!isRecord(payload) || !isRecord(payload.error)) return 'http_error'
  const { code } = payload.error
  if (status === 400 && (code === 'cursor_invalid' || code === 'cursor_filter_changed')) return code
  if (status === 410 && (code === 'cursor_reset' || code === 'cursor_expired')) return code
  return 'http_error'
}

function readRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delayMs = Number(value) * 1000
    return Number.isSafeInteger(delayMs) ? delayMs : undefined
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(value)) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined
}

async function requestJson(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  stage: GatewayStage,
): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...init, signal, redirect: 'manual', tls: { rejectUnauthorized: true } })
  } catch {
    throw new GatewayFailure(stage, signal.aborted ? 'timeout' : 'network_error')
  }

  const { status } = response
  const cursorFailure = stage === 'source' && url.pathname === usageRequestsPath && (status === 400 || status === 410)
  if (response.ok || cursorFailure) {
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      if (signal.aborted) throw new GatewayFailure(stage, 'timeout')
      if (!(error instanceof SyntaxError)) throw new GatewayFailure(stage, 'network_error')
      if (response.ok) throw new GatewayFailure(stage, 'invalid_response_json')
      throw new GatewayFailure(stage, 'http_error', status)
    }
    if (response.ok) return payload
    throw new GatewayFailure(stage, readCursorFailure(payload, status), status)
  }

  void response.body?.cancel().catch(() => undefined)
  let code: GatewayFailureCode = 'http_error'
  if (status >= 300 && status < 400) code = 'redirect_refused'
  else if (status === 401 || status === 403) code = 'unauthorized'
  else if (status === 404 || status === 405) code = 'gateway_unavailable'
  else if (status === 413 && stage === 'center') code = 'batch_too_large'
  else if (status === 429) code = 'rate_limited'
  else if (status >= 500 && status < 600) code = 'upstream_failure'
  const retryAfterMs = code === 'rate_limited' || code === 'upstream_failure'
    ? readRetryAfter(response.headers.get('retry-after'))
    : undefined
  throw new GatewayFailure(stage, code, status, retryAfterMs)
}

export async function readGatewayPid(baseUrl: URL, timeoutMs: number): Promise<number> {
  const payload = await requestJson(new URL('/', baseUrl), { method: 'GET' }, timeoutMs, 'source')
  if (!isRecord(payload) || payload.name !== 'magpie' || typeof payload.pid !== 'number'
    || !Number.isSafeInteger(payload.pid) || payload.pid <= 0) {
    throw new GatewayFailure('source', 'invalid_gateway_identity')
  }
  return payload.pid
}

export async function readUsagePage(
  baseUrl: URL,
  cursor: string,
  callerKeyId: string,
  timeoutMs: number,
): Promise<UsagePage> {
  const url = new URL(usageRequestsPath, baseUrl)
  url.search = new URLSearchParams({ cursor, via: 'through', limit: '500', callerKey: callerKeyId }).toString()
  const payload = await requestJson(url, { method: 'GET' }, timeoutMs, 'source')
  if (!isRecord(payload)) throw new GatewayFailure('source', 'invalid_source_page')

  const { rows, deleted, next_cursor: nextCursor, has_more: hasMore } = payload
  if (!Array.isArray(rows) || !rows.every(isRecord) || !Array.isArray(deleted)
    || typeof nextCursor !== 'string' || nextCursor === '' || nextCursor.trim() !== nextCursor
    || nextCursor === 'start' || nextCursor === 'now' || typeof hasMore !== 'boolean') {
    throw new GatewayFailure('source', 'invalid_source_page')
  }
  for (const entry of deleted) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0
      || typeof entry.seq !== 'number' || !Number.isSafeInteger(entry.seq) || entry.seq < 0) {
      throw new GatewayFailure('source', 'invalid_source_page')
    }
  }
  return { rows, deletedCount: deleted.length, nextCursor, hasMore }
}

export async function postUsageBatch(
  baseUrl: URL,
  key: string,
  body: string,
  expectedRids: readonly string[],
  timeoutMs: number,
): Promise<{ accepted: number; skipped: number }> {
  if (expectedRids.length === 0 || new Set(expectedRids).size !== expectedRids.length) {
    throw new GatewayFailure('center', 'invalid_batch')
  }

  const payload = await requestJson(new URL(usageRequestsPath, baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body,
  }, timeoutMs, 'center')
  if (!isRecord(payload) || !Array.isArray(payload.records) || payload.records.length !== expectedRids.length) {
    throw new GatewayFailure('center', 'invalid_receipt')
  }

  let accepted = 0
  let skipped = 0
  for (const [index, receipt] of payload.records.entries()) {
    if (!isRecord(receipt) || receipt.index !== index || receipt.rid !== expectedRids[index]) {
      throw new GatewayFailure('center', 'invalid_receipt')
    }
    if (receipt.status === 'accepted') accepted += 1
    else if (receipt.status === 'skipped') skipped += 1
    else throw new GatewayFailure('center', 'invalid_receipt')
  }
  if (payload.accepted !== accepted || payload.skipped !== skipped) {
    throw new GatewayFailure('center', 'invalid_receipt')
  }
  return { accepted, skipped }
}
