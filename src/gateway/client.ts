const usageRequestsPath = '/v1/magpie/usage/requests'

type GatewayStage = 'source' | 'center'

type GatewayFailureCode =
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'redirect_refused'
  | 'invalid_response_json'
  | 'invalid_source_page'
  | 'invalid_batch'
  | 'invalid_receipt'

export class GatewayFailure extends Error {
  readonly stage: GatewayStage
  readonly code: GatewayFailureCode
  readonly httpStatus?: number

  constructor(stage: GatewayStage, code: GatewayFailureCode, httpStatus?: number) {
    super(code)
    this.name = 'GatewayFailure'
    this.stage = stage
    this.code = code
    if (httpStatus !== undefined) this.httpStatus = httpStatus
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

  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    const redirected = response.status >= 300 && response.status < 400
    throw new GatewayFailure(stage, redirected ? 'redirect_refused' : 'http_error', response.status)
  }

  try {
    const payload: unknown = await response.json()
    return payload
  } catch {
    throw new GatewayFailure(stage, signal.aborted ? 'timeout' : 'invalid_response_json')
  }
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
    || typeof nextCursor !== 'string' || nextCursor.trim().length === 0 || typeof hasMore !== 'boolean') {
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
