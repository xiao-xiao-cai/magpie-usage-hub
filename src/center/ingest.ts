import { createHash } from 'node:crypto'
import { ingestPaths, pageBodyLimit, ProtocolFailure, readPageSubmission, readRecoveryReport } from '../sync/protocol.ts'
import { failure, jsonReply, readJsonBody } from './http.ts'
import { CenterFailure, type CenterLedger } from './ledger.ts'

const { checkpoint: checkpointPath, pages: pagesPath, recovery: recoveryPath } = ingestPaths
const recoveryBytes = 4096
const maxConcurrentSubmissions = 16
const maxConcurrentPerSource = 2

function digestOf(request: Request): string {
  const match = request.headers.get('Authorization')?.match(/^(\S+) ([0-9a-f]{64})$/u)
  if (match?.[1]?.toLowerCase() !== 'bearer' || !match[2]) throw new CenterFailure(401, 'report_key_invalid')
  return createHash('sha256').update(match[2], 'ascii').digest('hex')
}

export function createIngest(ledger: CenterLedger) {
  const inFlight = new Map<string, number>()
  let pending = 0

  return async function ingest(request: Request): Promise<Response> {
    const { pathname, search } = new URL(request.url)
    if (search || (pathname !== checkpointPath && pathname !== pagesPath && pathname !== recoveryPath)) {
      return failure(404, 'ingest_route_not_found')
    }
    const method = pathname === checkpointPath ? 'GET' : 'POST'
    if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: method } })

    try {
      const digest = digestOf(request)
      if (pathname === checkpointPath) return jsonReply(ledger.nodeCheckpoint(digest))
      const sourceId = ledger.authenticate(digest)
      const active = inFlight.get(sourceId) ?? 0
      if (pending >= maxConcurrentSubmissions || active >= maxConcurrentPerSource) {
        return failure(429, 'ingest_rate_limited')
      }
      inFlight.set(sourceId, active + 1)
      pending += 1
      try {
        const page = pathname === pagesPath
        const body = await readJsonBody(request, page ? pageBodyLimit : recoveryBytes)
        if (body instanceof Response) return body
        return jsonReply(page
          ? ledger.commit(readPageSubmission(body.value), digest)
          : ledger.recover(readRecoveryReport(body.value), digest))
      } finally {
        pending -= 1
        const remaining = (inFlight.get(sourceId) ?? 1) - 1
        if (remaining > 0) inFlight.set(sourceId, remaining)
        else inFlight.delete(sourceId)
      }
    } catch (error) {
      if (error instanceof CenterFailure) return failure(error.httpStatus, error.code)
      if (error instanceof ProtocolFailure) return failure(400, error.code)
      return failure(503, 'ingest_unavailable')
    }
  }
}
