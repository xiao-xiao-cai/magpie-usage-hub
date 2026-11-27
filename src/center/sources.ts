import { readDigest, readRevision, readSourceId } from '../sync/protocol.ts'
import { failure, isRecord, jsonReply, readJsonBody } from './http.ts'
import { CenterFailure, type CenterLedger, type SourceEdit } from './ledger.ts'

function readName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (name.length === 0 || [...name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) return null
  return name
}

function readEdit(value: unknown): SourceEdit | null {
  if (!isRecord(value)) return null
  const revision = readRevision(value.revision)
  if (!revision) return null
  const { action, enabled } = value
  if (action === 'create') {
    const name = readName(value.name)
    const digest = readDigest(value.digest)
    if (!name || !digest || (enabled !== undefined && typeof enabled !== 'boolean')) return null
    return { revision, action, name, digest, enabled: enabled ?? true }
  }

  const id = readSourceId(value.id)
  if (!id) return null
  if (action === 'update') {
    const name = value.name === undefined ? undefined : readName(value.name)
    if (name === null || (enabled !== undefined && typeof enabled !== 'boolean')) return null
    if (name === undefined && enabled === undefined) return null
    return { revision, action, id, ...(name === undefined ? {} : { name }), ...(enabled === undefined ? {} : { enabled }) }
  }
  if (action === 'rotate') {
    const digest = readDigest(value.digest)
    return digest ? { revision, action, id, digest } : null
  }
  if (action === 'revoke') {
    const { slot } = value
    return slot === 'current' || slot === 'pending' || slot === 'all' ? { revision, action, id, slot } : null
  }
  return action === 'rebuild' ? { revision, action, id } : null
}

function describe(snapshot: ReturnType<CenterLedger['managementSnapshot']>, status = 200): Response {
  return jsonReply({ revision: snapshot.revision, sources: snapshot.sources.map(({ activeGeneration, ...source }) => source) }, status)
}

export function createSourceManagement(ledger: CenterLedger) {
  return async function manage(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname !== '/api/sources') return failure(404, 'source_not_found')

    try {
      if (request.method === 'GET') return describe(ledger.managementSnapshot())
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } })
      const body = await readJsonBody(request, 16 * 1024)
      if (body instanceof Response) return body
      const edit = readEdit(body.value)
      if (!edit) return failure(400, 'invalid_source')
      return describe(ledger.editSource(edit), edit.action === 'create' ? 201 : 200)
    } catch (error) {
      if (error instanceof CenterFailure) return failure(error.httpStatus, error.code)
      return failure(503, 'source_save_failed')
    }
  }
}
