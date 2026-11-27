import { expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIngest } from '../../src/center/ingest.ts'
import { openCenterLedger } from '../../src/center/ledger.ts'
import { openReportingTarget } from '../../src/gateway/reporting.ts'
import { mapNativePage } from '../../src/sync/mapping.ts'
import { ingestPaths } from '../../src/sync/protocol.ts'
import { synchronizeRound } from '../../src/sync/runner.ts'

function nativeRow(seq: number, id: string, origin = 'gateway') {
  return {
    id: `u_${id.repeat(20)}`, seq, origin, t: '2026-11-25T13:59:01.123456789+08:00',
    model: 'fixture-model', in: 13, out: 5, cache_read: 2, cache_write: 1, priced: true, cost: 0,
    status: origin === 'session' ? 0 : 200, ms: 0,
    original_ids: { session_id: 'fixture-private-identifier' }, providerAccount: 'fixture-account',
  }
}

test('sender reads the durable checkpoint after a lost acknowledgement and applies late events and tombstones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mpu-reporting-'))
  const key = randomBytes(32).toString('hex')
  const keyFile = join(directory, 'fixture.key')
  await writeFile(keyFile, key, { mode: 0o600 })
  const ledger = openCenterLedger(':memory:')
  const { sources } = ledger.editSource({ revision: ledger.managementSnapshot().revision, action: 'create',
    name: 'Fixture Windows', enabled: true, digest: createHash('sha256').update(key).digest('hex') })
  const sourceId = sources.find(source => !source.isLocal)!.id
  const readCursors: string[] = []
  const sentBodies: string[] = []
  let expire = false
  let resized = false
  let dropAcknowledgement = true
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    const url = new URL(request.url)
    const cursor = url.searchParams.get('cursor')
    if (url.pathname !== '/v1/magpie/usage/requests' || cursor === null) return new Response(null, { status: 404 })
    expect(Array.from(url.searchParams.keys())).toEqual(['cursor', 'limit'])
    readCursors.push(cursor)
    if (expire && cursor === 'third') return Response.json({ error: { code: 'cursor_expired' } }, { status: 410 })
    if (cursor === 'start' && !expire && !resized) {
      resized = true
      return new Response(' '.repeat(1024 * 1024 + 1))
    }
    if (cursor === 'start') return Response.json({ rows: [nativeRow(1, 'a'), nativeRow(2, 'b', 'reported')],
      deleted: [], next_cursor: expire ? 'rebuilt' : 'second', has_more: false })
    expect(cursor).toBe('second')
    return Response.json({ rows: [nativeRow(3, 'c', 'session')], deleted: [{ id: 'u_' + 'a'.repeat(20), seq: 4 }],
      next_cursor: 'third', has_more: false })
  } })
  const ingest = createIngest(ledger)
  const center = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const isPage = new URL(request.url).pathname === ingestPaths.pages
    if (isPage) sentBodies.push(await request.clone().text())
    const response = await ingest(request)
    if (isPage && dropAcknowledgement) {
      dropAcknowledgement = false
      expect(response.status).toBe(200)
      return new Response(null, { status: 503 })
    }
    return response
  } })
  try {
    const round = async () => synchronizeRound({ gateway: gateway.url, timeoutMs: 1_000, sourceId },
      await openReportingTarget(center.url, keyFile, 1_000), () => {}, () => {})
    await expect(round()).rejects.toThrow('unavailable')
    expect(ledger.checkpoint(sourceId)).toMatchObject({ cursor: 'second', phase: 'sync' })
    expect((await round()).cursor).toBe('third')
    expect(readCursors).toEqual(['start', 'start', 'second'])
    expect(sentBodies.join('')).not.toContain('fixture-private-identifier')
    expect(sentBodies.join('')).not.toContain('fixture-account')
    expect(sentBodies.join('')).not.toContain('u_' + 'b'.repeat(20))
    expect(ledger.db.query('SELECT t, via, cost, status, duration_ms FROM usage_rows').all()).toEqual([
      { t: '2026-11-25T13:59:01.123456789+08:00', via: 'direct', cost: 0, status: null, duration_ms: null },
    ])
    expire = true
    expect(await round()).toMatchObject({ cursor: 'start', phase: 'rebuilding' })
    expect(ledger.db.query('SELECT via FROM usage_rows').all()).toEqual([{ via: 'direct' }])
    expect(await round()).toMatchObject({ cursor: 'rebuilt', phase: 'sync' })
    expect(ledger.db.query('SELECT via FROM usage_rows').all()).toEqual([{ via: 'through' }])
  } finally {
    await center.stop(true)
    await gateway.stop(true)
    ledger.db.close()
    const { unlink, rmdir } = await import('node:fs/promises')
    await unlink(keyFile)
    await rmdir(directory)
  }
})

test('projects native optional metrics and retracts changed rows outside the local usage scope', () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const checkpoint = ledger.checkpoint('local')
    const page = mapNativePage({ rows: [
      { ...nativeRow(1, 'a'), handed_on: true, reasoning: 4, cache_unknown: true },
      { ...nativeRow(2, 'b', 'session'), priced: false },
      { ...nativeRow(3, 'c'), computer: 'another-instance' },
    ], deleted: [], next_cursor: 'first', has_more: false }, checkpoint)
    expect(page.upserts).toEqual([
      { rowKey: createHash('sha256').update('u_' + 'a'.repeat(20)).digest('hex'), seq: 1, t: nativeRow(1, 'a').t,
        via: 'through', model: 'fixture-model', handedOn: true, input: 13, output: 5, cacheRead: 2, cacheWrite: 1,
        reasoning: 4, cacheUnknown: true, cost: 0, status: 200, durationMs: 0 },
      { rowKey: createHash('sha256').update('u_' + 'b'.repeat(20)).digest('hex'), seq: 2, t: nativeRow(2, 'b').t,
        via: 'direct', model: 'fixture-model', handedOn: false, input: 13, output: 5, cacheRead: 2, cacheWrite: 1,
        reasoning: 0, cacheUnknown: false, cost: null, status: null, durationMs: null },
    ])
    expect(page.removals).toEqual([{ rowKey: createHash('sha256').update('u_' + 'c'.repeat(20)).digest('hex'), seq: 3 }])
    const receipt = ledger.commit(page)
    const correction = mapNativePage({ rows: [{ ...nativeRow(4, 'a'), computer: 'another-instance' }, nativeRow(5, 'c')],
      deleted: [], next_cursor: 'second', has_more: false }, receipt.checkpoint)
    expect(ledger.commit(correction)).toMatchObject({ upserted: 1, removed: 1 })
    expect(ledger.db.query('SELECT seq FROM usage_rows ORDER BY seq').all()).toEqual([{ seq: 2 }, { seq: 5 }])
  } finally {
    ledger.db.close()
  }
})

test('bounds a backlog round and resumes its unpublished backfill from the confirmed page', async () => {
  const ledger = openCenterLedger(':memory:')
  const sourceId = 'local'
  const cursors: (string | null)[] = []
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    const cursor = new URL(request.url).searchParams.get('cursor')
    cursors.push(cursor)
    const sequence = cursor === 'start' ? 1 : Number(cursor) + 1
    return Response.json({ rows: [nativeRow(sequence, sequence.toString(16))],
      deleted: [], has_more: sequence < 7, next_cursor: String(sequence) })
  } })
  const target = {
    checkpoint: () => ledger.checkpoint(sourceId),
    commit: ledger.commit,
    recover: ledger.recover,
  }
  try {
    const round = () => synchronizeRound({ gateway: gateway.url, timeoutMs: 1_000, sourceId }, target, () => {}, () => {})
    expect(await round()).toMatchObject({ cursor: '5', phase: 'backfill', hasMore: true })
    expect(ledger.getSources()[0]?.activeGeneration).toBeNull()
    expect(cursors).toEqual(['start', '1', '2', '3', '4'])
    expect(await round()).toMatchObject({ cursor: '7', phase: 'sync', hasMore: false })
    expect(cursors).toEqual(['start', '1', '2', '3', '4', '5', '6'])
    expect(ledger.getSources()[0]?.activeGeneration).not.toBeNull()
    expect(ledger.db.query('SELECT count(*) AS count FROM usage_rows').get()).toEqual({ count: 7 })
  } finally {
    await gateway.stop(true)
    ledger.db.close()
  }
})
