import { createHash } from 'node:crypto'
import { isRecord } from '../center/http.ts'
import { GatewayFailure } from '../gateway/client.ts'
import { pageLimit, ProtocolFailure, readPageSubmission,
  type Checkpoint, type PageSubmission } from './protocol.ts'

function readChange(value: unknown) {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^u_[a-f0-9]{20}$/u.test(value.id)) {
    throw new GatewayFailure('incompatible_response')
  }
  return { rowKey: createHash('sha256').update(value.id).digest('hex'), seq: value.seq }
}

export function mapNativePage(value: unknown, checkpoint: Checkpoint): PageSubmission {
  if (!isRecord(value) || !Array.isArray(value.rows) || !Array.isArray(value.deleted)
    || value.rows.length + value.deleted.length > pageLimit) throw new GatewayFailure('incompatible_response')
  const removals = value.deleted.map(readChange)
  const upserts: unknown[] = []
  for (const row of value.rows) {
    if (!isRecord(row) || (row.computer !== undefined && typeof row.computer !== 'string')
      || (row.origin !== 'gateway' && row.origin !== 'session' && row.origin !== 'reported' && row.origin !== '')) {
      throw new GatewayFailure('incompatible_response')
    }
    const change = readChange(row)
    if (row.computer || row.origin === 'reported' || row.origin === '') {
      removals.push(change)
      continue
    }
    if (typeof row.priced !== 'boolean') throw new GatewayFailure('incompatible_response')
    upserts.push({
      ...change, t: row.t, via: row.origin === 'gateway' ? 'through' : 'direct', model: row.model,
      handedOn: row.handed_on === undefined ? false : row.handed_on,
      input: row.in, output: row.out, cacheRead: row.cache_read, cacheWrite: row.cache_write,
      reasoning: row.reasoning === undefined ? 0 : row.reasoning,
      cacheUnknown: row.cache_unknown === undefined ? false : row.cache_unknown,
      cost: row.priced ? row.cost : null,
      status: row.status === 0 || row.status === undefined ? null : row.status,
      durationMs: row.ms === undefined || (row.origin === 'session' && row.ms === 0) ? null : row.ms,
    })
  }
  try {
    const page = readPageSubmission({
      sourceId: checkpoint.sourceId, revision: checkpoint.revision, nextCursor: value.next_cursor,
      hasMore: value.has_more, upserts, removals,
    })
    if (page.nextCursor === checkpoint.cursor && (page.hasMore || upserts.length || removals.length)) {
      throw new ProtocolFailure('invalid_page_progress')
    }
    return page
  } catch (error) {
    if (error instanceof ProtocolFailure) throw new GatewayFailure('incompatible_response')
    throw error
  }
}
