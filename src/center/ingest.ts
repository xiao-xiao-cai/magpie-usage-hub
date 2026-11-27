import { createHash } from 'node:crypto'
import { failure, jsonReply, readBoundedJson } from './http.ts'
import { CenterFailure } from './ledger.ts'
import { OtlpParseFailure, readOtlpTraces, type OtlpRow } from './otlp.ts'

export const maximumOtlpBodyBytes = 4 * 1024 * 1024
const maxConcurrentSubmissions = 16
const maxConcurrentPerSource = 2

type IngestLedger = {
  authenticateOtlp(digest: string): string
  commitOtlp(digest: string, rows: readonly OtlpRow[], sourceId: string): void
}

function digestOf(request: Request): string {
  const match = request.headers.get('Authorization')?.match(/^(\S+) ([0-9a-f]{64})$/u)
  if (match?.[1]?.toLowerCase() !== 'bearer' || !match[2]) throw new CenterFailure(401, 'report_key_invalid')
  return createHash('sha256').update(match[2], 'ascii').digest('hex')
}

export function createIngest(ledger: IngestLedger) {
  const inFlight = new Map<string, number>()
  let pending = 0

  return async function ingest(request: Request): Promise<Response> {
    const { pathname, search } = new URL(request.url)
    if (search || pathname !== '/v1/traces') return failure(404, 'ingest_route_not_found')
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })

    try {
      const digest = digestOf(request)
      const sourceId = ledger.authenticateOtlp(digest)
      const encoding = request.headers.get('content-encoding')?.trim().toLowerCase()
      if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') ?? '')
        || (encoding && encoding !== 'identity')) return failure(415, 'unsupported_media_type')

      const active = inFlight.get(sourceId) ?? 0
      if (pending >= maxConcurrentSubmissions || active >= maxConcurrentPerSource) {
        return failure(429, 'ingest_rate_limited')
      }
      inFlight.set(sourceId, active + 1)
      pending += 1
      try {
        let payload: unknown
        try {
          payload = await readBoundedJson(request, maximumOtlpBodyBytes)
        } catch (error) {
          return error instanceof RangeError ? failure(413, 'otlp_body_too_large') : failure(400, 'invalid_otlp_traces')
        }
        const { rows, rejectedSpans } = readOtlpTraces(payload)
        if (rejectedSpans > 0 && rows.length === 0) return failure(400, 'invalid_otlp_traces')
        ledger.commitOtlp(digest, rows, sourceId)
        return jsonReply(rejectedSpans === 0 ? {} : { partialSuccess: { rejectedSpans: String(rejectedSpans) } })
      } finally {
        pending -= 1
        const remaining = (inFlight.get(sourceId) ?? 1) - 1
        if (remaining > 0) inFlight.set(sourceId, remaining)
        else inFlight.delete(sourceId)
      }
    } catch (error) {
      if (error instanceof CenterFailure) return failure(error.httpStatus, error.code)
      if (error instanceof OtlpParseFailure) return failure(400, 'invalid_otlp_traces')
      return failure(503, 'ingest_unavailable')
    }
  }
}
