import { isRecord, readBoundedJson } from '../center/http.ts'
import { pageLimit, readCursorFailure, type CursorFailure } from '../sync/protocol.ts'
import { requestDirect } from './direct.ts'

const maxResponseBytes = 1_048_576

type GatewayFailureCode = 'timeout' | 'unavailable' | 'incompatible_response' | 'unauthorized' | 'forbidden'
  | 'redirect' | 'rate_limited' | 'response_too_large' | 'invalid_gateway_identity' | 'center_owner_mismatch' | CursorFailure

export class GatewayFailure extends Error {
  constructor(readonly code: GatewayFailureCode, readonly httpStatus?: number) {
    super(code)
  }
}

async function readGatewayJson(url: URL, signal: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await requestDirect(url, { method: 'GET' }, signal)
  } catch {
    throw new GatewayFailure(signal.aborted ? 'timeout' : 'unavailable')
  }

  if (response.ok) {
    try {
      return await readBoundedJson(response, maxResponseBytes)
    } catch (error) {
      throw new GatewayFailure(signal.aborted ? 'timeout' : error instanceof RangeError ? 'response_too_large' : 'incompatible_response')
    }
  }

  const { status } = response
  if ((status === 400 || status === 410) && url.searchParams.has('cursor')) {
    const value = await readBoundedJson(response, maxResponseBytes).catch(() => undefined)
    if (signal.aborted) throw new GatewayFailure('timeout')
    const code = isRecord(value) && isRecord(value.error) ? readCursorFailure(value.error.code) : null
    throw new GatewayFailure(code ?? 'incompatible_response', status)
  } else {
    void response.body?.cancel().catch(() => {})
  }
  const code = status >= 300 && status < 400 ? 'redirect' : status === 401 ? 'unauthorized'
    : status === 403 ? 'forbidden' : status === 429 ? 'rate_limited'
      : status < 500 ? 'incompatible_response' : 'unavailable'
  throw new GatewayFailure(code, status)
}

export async function readNativeChanges(baseUrl: URL, cursor: string, timeoutMs: number): Promise<unknown> {
  const url = new URL('/v1/magpie/usage/requests', baseUrl)
  for (let limit = pageLimit; ; limit = Math.max(1, Math.floor(limit / 2))) {
    url.search = new URLSearchParams({ cursor, limit: String(limit) }).toString()
    try {
      return await readGatewayJson(url, AbortSignal.timeout(timeoutMs))
    } catch (error) {
      if (limit === 1 || !(error instanceof GatewayFailure) || error.code !== 'response_too_large') throw error
    }
  }
}

export async function readGatewayPid(baseUrl: URL, timeoutMs: number): Promise<number> {
  const payload = await readGatewayJson(new URL('/', baseUrl), AbortSignal.timeout(timeoutMs))
  if (!isRecord(payload) || payload.name !== 'magpie' || typeof payload.pid !== 'number'
    || !Number.isSafeInteger(payload.pid) || payload.pid <= 0) {
    throw new GatewayFailure('invalid_gateway_identity')
  }
  return payload.pid
}
