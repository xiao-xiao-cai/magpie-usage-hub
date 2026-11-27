import { GatewayFailure, readGatewayJson } from '../gateway/client.ts'
import { isRecord, jsonReply, failure } from './http.ts'

const requestsPath = '/v1/magpie/usage/requests'
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u

type Period = 'today' | '7d' | '30d'
type NativeSource = { name: string; gatewayUrl: string; key?: string; enabled: boolean }

function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new GatewayFailure('incompatible_response')
  return value
}

function readCost(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new GatewayFailure('incompatible_response')
  return value
}

function readSince(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !timestampPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new GatewayFailure('incompatible_response')
  }
  return value
}

function readUsage(value: unknown, period: Period) {
  if (!isRecord(value) || value.period !== period || !isRecord(value.through) || !isRecord(value.direct)) {
    throw new GatewayFailure('incompatible_response')
  }
  const { through, direct, series } = value
  const firstPoint: unknown = Array.isArray(series) ? series[0] : undefined
  const since = readSince(value.since ?? (isRecord(firstPoint) ? firstPoint.time : undefined))
  const count = (field: string) => readCount(readCount(through[field]) + readCount(direct[field]))
  const totals = {
    calls: count('calls'), input: count('input'), output: count('output'),
    cacheRead: count('cache_read'), cacheWrite: count('cache_write'), unpriced: count('unpriced'),
    cost: readCost(readCost(through.cost) + readCost(direct.cost)),
  }
  return { since, totals }
}

async function readNative(source: NativeSource, period: Period, signal: AbortSignal) {
  const url = new URL(requestsPath, source.gatewayUrl)
  url.search = new URLSearchParams({ computer: 'this', period, offset: '0', limit: '1' }).toString()
  return readUsage(await readGatewayJson(url, signal, source.key), period)
}

function describeFailure(error: unknown) {
  return error instanceof GatewayFailure ? { code: error.code, httpStatus: error.httpStatus } : { code: 'unavailable' }
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([timeout, signal]) : timeout
}

export async function testNativeConnection(source: NativeSource, timeoutMs: number, signal?: AbortSignal) {
  const combined = requestSignal(timeoutMs, signal)
  try {
    await readNative(source, 'today', combined)
    const summary = await readGatewayJson(new URL('/v1/magpie/usage?period=today', source.gatewayUrl), combined, source.key)
    if (!isRecord(summary) || summary.period !== 'today') throw new GatewayFailure('incompatible_response')
    return { status: 'ok', checkedAt: new Date().toISOString(), failure: null }
  } catch (error) {
    return { status: 'unavailable', checkedAt: new Date().toISOString(), failure: describeFailure(error) }
  }
}

async function querySource(source: NativeSource, period: Period, timeoutMs: number, signal?: AbortSignal) {
  const { name } = source
  if (!source.enabled) return { name, status: 'paused', since: null, totals: null, checkedAt: null, failure: null }
  try {
    const usage = await readNative(source, period, requestSignal(timeoutMs, signal))
    return { name, status: 'ok', ...usage, checkedAt: new Date().toISOString(), failure: null }
  } catch (error) {
    return { name, status: 'unavailable', since: null, totals: null, checkedAt: new Date().toISOString(),
      failure: describeFailure(error),
    }
  }
}

export function createDashboard(centerGatewayUrl: URL, timeoutMs: number, getSources: () => readonly NativeSource[]) {
  const local = { name: '中心本机', gatewayUrl: centerGatewayUrl.href, enabled: true }
  return async (url: URL, signal?: AbortSignal): Promise<Response> => {
    const requested = url.searchParams.get('period') ?? '7d'
    if (requested !== 'today' && requested !== '7d' && requested !== '30d') return failure(400, 'invalid_usage_query')
    const period: Period = requested
    const sources = [local, ...getSources()]
    const results: Awaited<ReturnType<typeof querySource>>[] = new Array(sources.length)
    let upcoming = 0
    async function queryNext() {
      for (;;) {
        if (signal?.aborted) return
        const index = upcoming++
        const source = sources[index]
        if (!source) return
        results[index] = await querySource(source, period, timeoutMs, signal)
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, queryNext))
    if (signal?.aborted) return failure(408, 'usage_query_canceled')
    return jsonReply({ schema: 'magpie-usage-hub/usage-v2', period, sources: results })
  }
}
