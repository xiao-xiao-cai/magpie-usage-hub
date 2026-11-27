import { isRecord, readBoundedJson } from '../center/http.ts'
import { requestDirect } from './direct.ts'

const maxResponseBytes = 1_048_576

type GatewayFailureCode = 'timeout' | 'unavailable' | 'incompatible_response' | 'unauthorized' | 'forbidden'
  | 'redirect' | 'restricted_key' | 'invalid_gateway_identity' | 'center_owner_mismatch'

export class GatewayFailure extends Error {
  constructor(readonly code: GatewayFailureCode, readonly httpStatus?: number) {
    super(code)
  }
}

export async function readGatewayJson(url: URL, signal: AbortSignal, key?: string): Promise<unknown> {
  let response: Response
  try {
    response = await requestDirect(url, {
      method: 'GET', ...(key === undefined ? {} : { headers: { Authorization: `Bearer ${key}` } }),
    }, signal)
  } catch {
    throw new GatewayFailure(signal.aborted ? 'timeout' : 'unavailable')
  }

  if (response.ok) {
    try {
      return await readBoundedJson(response, maxResponseBytes)
    } catch {
      throw new GatewayFailure(signal.aborted ? 'timeout' : 'incompatible_response')
    }
  }

  const { status } = response
  if (status === 403 && url.pathname === '/v1/magpie/usage') {
    const value = await readBoundedJson(response, maxResponseBytes).catch(() => undefined)
    if (signal.aborted) throw new GatewayFailure('timeout')
    if (isRecord(value) && isRecord(value.error) && value.error.code === 'gateway_key_held') {
      throw new GatewayFailure('restricted_key', status)
    }
  } else {
    void response.body?.cancel().catch(() => {})
  }
  const code = status >= 300 && status < 400 ? 'redirect' : status === 401 ? 'unauthorized'
    : status === 403 ? 'forbidden' : status === 404 || status === 405 ? 'incompatible_response' : 'unavailable'
  throw new GatewayFailure(code, status)
}

export async function readGatewayPid(baseUrl: URL, timeoutMs: number): Promise<number> {
  const payload = await readGatewayJson(new URL('/', baseUrl), AbortSignal.timeout(timeoutMs))
  if (!isRecord(payload) || payload.name !== 'magpie' || typeof payload.pid !== 'number'
    || !Number.isSafeInteger(payload.pid) || payload.pid <= 0) {
    throw new GatewayFailure('invalid_gateway_identity')
  }
  return payload.pid
}
