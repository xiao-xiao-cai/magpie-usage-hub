import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createIngest } from '../../src/center/ingest.ts'
import { type CenterLedger, openCenterLedger } from '../../src/center/ledger.ts'
import { createSourceManagement } from '../../src/center/sources.ts'
import type { Checkpoint, PageReceipt, PageSubmission, UsageRow } from '../../src/sync/protocol.ts'

const keyA = 'a'.repeat(64)
const keyB = 'b'.repeat(64)
const keyNext = 'c'.repeat(64)
const rowKey = 'd'.repeat(64)
const olderKey = 'e'.repeat(64)
const recent = '2026-11-27T19:00:00+08:00'
const older = '2026-10-04T09:10:11-04:00'

function digest(key: string): string {
  return createHash('sha256').update(key, 'ascii').digest('hex')
}

function request(path: string, body?: object, key?: string): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }) },
    body: body === undefined ? null : JSON.stringify(body),
  })
}

function createSource(ledger: CenterLedger, name: string, key: string): string {
  const result = ledger.editSource({ revision: ledger.managementSnapshot().revision, action: 'create',
    name, digest: digest(key), enabled: true })
  return result.sources.find(source => source.name === name)!.id
}

function row(seq: number, patch: Partial<UsageRow> = {}): UsageRow {
  return { seq, rowKey, t: recent, via: 'through', model: 'synthetic-model', handedOn: false,
    input: 8, output: 12, cacheRead: 0, cacheWrite: 0, reasoning: 0, cacheUnknown: false,
    cost: 0, status: 200, durationMs: 100, ...patch }
}

function page(checkpoint: Checkpoint, position: number, upserts: UsageRow[] = [], hasMore = false): PageSubmission {
  return { sourceId: checkpoint.sourceId, revision: checkpoint.revision, nextCursor: `fixture-cursor-${position}`,
    hasMore, upserts, removals: [] }
}

function visibleRows(ledger: CenterLedger, id: string) {
  return ledger.db.query(`SELECT row_key, seq, t, time_ms, input FROM usage_rows
    JOIN sources ON sources.id = usage_rows.source_id AND sources.active_generation = usage_rows.generation
    WHERE id = ? ORDER BY usage_rows.time_ms`).all(id)
}

test('management serializes revisions and confirms a replacement key before promotion', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const manage = createSourceManagement(ledger)
    const ingest = createIngest(ledger)
    const endpoint = '/api/sources'
    const get = async () => await (await manage(request(endpoint))).json()
    const draft = { revision: (await get()).revision, action: 'create', name: '合成 Windows', digest: digest(keyA).toUpperCase() }
    const requests = await Promise.all([manage(request(endpoint, draft)), manage(request(endpoint, draft))])
    expect(requests.map(response => response.status).sort()).toEqual([201, 409])
    const savedText = await requests.find(response => response.status === 201)!.text()
    expect(savedText).not.toContain(digest(keyA))
    expect(savedText).not.toContain(keyA)
    expect(savedText).not.toContain('activeGeneration')
    const { sources } = JSON.parse(savedText)
    expect(sources).toMatchObject([{ id: 'local', isLocal: true }, { name: draft.name, isLocal: false, phase: 'backfill',
      credentials: { current: true, pending: false, pendingVerified: false } }])
    const id = sources[1].id
    const edit = async (action: object) => manage(request(endpoint, { revision: (await get()).revision, ...action }))
    expect(await (await edit({ action: 'create', name: '重复摘要', digest: digest(keyA) })).json()).toEqual({
      error: { code: 'credential_in_use' },
    })
    expect((await get()).sources).toHaveLength(2)

    expect((await edit({ action: 'rotate', id, digest: digest(keyNext) })).status).toBe(200)
    expect((await edit({ action: 'revoke', id, slot: 'current' })).status).toBe(409)
    const accepted = await ingest(request('/v1/usage-hub/checkpoint', undefined, keyNext))
    expect(await accepted.json()).toMatchObject({ sourceId: id, cursor: 'start' })
    expect((await get()).sources[1]).toMatchObject({ lastSeenAt: expect.any(String),
      credentials: { current: true, pending: true, pendingVerified: true } })
    expect((await edit({ action: 'revoke', id, slot: 'current' })).status).toBe(200)
    expect((await ingest(request('/v1/usage-hub/checkpoint', undefined, keyA))).status).toBe(401)
    expect((await ingest(request('/v1/usage-hub/checkpoint', undefined, keyNext))).status).toBe(200)
    expect((await edit({ action: 'update', id, name: '合成新名称', enabled: false })).status).toBe(200)
    const paused = await (await ingest(request('/v1/usage-hub/checkpoint', undefined, keyNext))).json() as Checkpoint
    expect(paused).toMatchObject({ sourceId: id, cursor: 'start', phase: 'paused' })
    const rejected = await ingest(request('/v1/usage-hub/pages', page(paused, 1), keyNext))
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toEqual({ error: { code: 'source_paused' } })
    expect((await edit({ action: 'revoke', id, slot: 'all' })).status).toBe(200)
    expect((await ingest(request('/v1/usage-hub/checkpoint', undefined, keyNext))).status).toBe(401)
  } finally {
    ledger.db.close()
  }
})

test('ingest authenticates before parsing and isolates simultaneous sources and retries', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const sourceA = createSource(ledger, 'Windows A', keyA)
    const sourceB = createSource(ledger, 'Windows B', keyB)
    const ingest = createIngest(ledger)
    const path = '/v1/usage-hub/pages'
    const unauthenticated = new Request(`http://127.0.0.1${path}`, { method: 'POST', body: 'not json' })
    expect((await ingest(unauthenticated)).status).toBe(401)
    expect(unauthenticated.bodyUsed).toBe(false)
    const oversized = new Request(`http://127.0.0.1${path}`, { method: 'POST', body: '{}', headers: {
      Authorization: `Bearer ${keyA}`, 'Content-Type': 'application/json', 'Content-Length': '1048577',
    } })
    expect((await ingest(oversized)).status).toBe(413)

    const checkpointA = ledger.checkpoint(sourceA)
    const checkpointB = ledger.checkpoint(sourceB)
    const payloadA = page(checkpointA, 1, [row(1)], true)
    const payloadB = page(checkpointB, 1, [row(1, { input: 99 })])
    expect((await ingest(request(path, payloadA, keyB))).status).toBe(403)
    const results = await Promise.all([ingest(request(path, payloadA, keyA)), ingest(request(path, payloadA, keyA)),
      ingest(request(path, payloadB, keyB))])
    expect(results.map(result => result.status).sort()).toEqual([200, 200, 409])
    expect(visibleRows(ledger, sourceA)).toEqual([])
    expect(visibleRows(ledger, sourceB)).toMatchObject([{ row_key: rowKey, input: 99 }])

    const currentA = ledger.checkpoint(sourceA)
    expect(currentA).toMatchObject({ phase: 'backfill', cursor: payloadA.nextCursor, lastSyncedAt: null })
    const empty = await ingest(request(path, page(currentA, 2), keyA))
    expect(await empty.json()).toMatchObject({ checkpoint: { phase: 'sync', cursor: 'fixture-cursor-2',
      lastSyncedAt: expect.any(String) }, upserted: 0, removed: 0 })
    expect(visibleRows(ledger, sourceA)).toMatchObject([{ row_key: rowKey, input: 8 }])

    const correction = page(ledger.checkpoint(sourceA), 3, [row(3, { input: 18 }), row(2, { rowKey: olderKey, t: older, via: 'direct' })])
    expect((await ingest(request(path, correction, keyA))).status).toBe(200)
    expect(visibleRows(ledger, sourceA)).toEqual([
      { row_key: olderKey, seq: 2, t: older, time_ms: Date.parse(older), input: 8 },
      { row_key: rowKey, seq: 3, t: recent, time_ms: Date.parse(recent), input: 18 },
    ])
    const deletion = { ...page(ledger.checkpoint(sourceA), 4), removals: [{ rowKey, seq: 4 }] }
    expect(await (await ingest(request(path, deletion, keyA))).json()).toMatchObject({ removed: 1 })
    expect(visibleRows(ledger, sourceA)).toHaveLength(1)
    expect(visibleRows(ledger, sourceB)).toMatchObject([{ row_key: rowKey, input: 99 }])
    const staleChange = page(ledger.checkpoint(sourceA), 5, [row(3)])
    expect((await ingest(request(path, staleChange, keyA))).status).toBe(400)
    expect(visibleRows(ledger, sourceA)).toHaveLength(1)
  } finally {
    ledger.db.close()
  }
})

test('a failed checkpoint update rolls back the page and retry publishes it once', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const sourceId = createSource(ledger, 'Windows A', keyA)
    const ingest = createIngest(ledger)
    const checkpoint = ledger.checkpoint(sourceId)
    const payload = page(checkpoint, 1, [row(1)])
    ledger.db.exec(`CREATE TEMP TRIGGER fixture_write_failure BEFORE UPDATE OF cursor ON sources
      BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;`)
    const failed = await ingest(request('/v1/usage-hub/pages', payload, keyA))
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ error: { code: 'ingest_unavailable' } })
    expect(ledger.db.query('SELECT row_key FROM usage_rows').all()).toEqual([])
    expect(ledger.checkpoint(sourceId)).toEqual(checkpoint)
    ledger.db.exec('DROP TRIGGER fixture_write_failure')
    expect((await ingest(request('/v1/usage-hub/pages', payload, keyA))).status).toBe(200)
    expect((await ingest(request('/v1/usage-hub/pages', payload, keyA))).status).toBe(409)
    expect(visibleRows(ledger, sourceId)).toHaveLength(1)
  } finally {
    ledger.db.close()
  }
})

test('a revoked credential cannot finish an in-flight page and another source can still submit', async () => {
  const ledger = openCenterLedger(':memory:')
  const upload = Promise.withResolvers<void>()
  try {
    const sourceA = createSource(ledger, 'Windows A', keyA)
    const sourceB = createSource(ledger, 'Windows B', keyB)
    const path = '/v1/usage-hub/pages'
    const ingest = createIngest(ledger)
    const draft = page(ledger.checkpoint(sourceA), 1, [row(1)])
    const makeDelayedRequest = () => new Request(`http://127.0.0.1${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${keyA}`, 'Content-Type': 'application/json' },
      body: new ReadableStream({ async pull(controller) {
        await upload.promise
        controller.enqueue(new TextEncoder().encode(JSON.stringify(draft)))
        controller.close()
      } }),
    })
    const pending = [ingest(makeDelayedRequest()), ingest(makeDelayedRequest())]
    expect((await ingest(request(path, draft, keyA))).status).toBe(429)
    expect((await ingest(request(path, page(ledger.checkpoint(sourceB), 1, [row(1)]), keyB))).status).toBe(200)
    ledger.editSource({ revision: ledger.managementSnapshot().revision, action: 'revoke', id: sourceA, slot: 'all' })
    upload.resolve()
    expect((await Promise.all(pending)).map(response => response.status)).toEqual([401, 401])
    expect(ledger.checkpoint(sourceA).cursor).toBe('start')
    expect(visibleRows(ledger, sourceB)).toHaveLength(1)
  } finally {
    upload.resolve()
    ledger.db.close()
  }
})

test('recovery stages a replacement, records missing events, and requires approval for a reset', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const sourceId = createSource(ledger, 'Windows A', keyA)
    const ingest = createIngest(ledger)
    const manage = createSourceManagement(ledger)
    const first = ledger.commit(page(ledger.checkpoint(sourceId), 2, [row(1, { rowKey: olderKey, t: older }), row(2)]))
    const denied = await ingest(request('/v1/usage-hub/recovery', { sourceId, revision: first.checkpoint.revision,
      reason: 'cursor_expired' }, keyB))
    expect(denied.status).toBe(401)
    const expiry = await ingest(request('/v1/usage-hub/recovery', { sourceId, revision: first.checkpoint.revision,
      reason: 'cursor_expired' }, keyA))
    const rebuilding = await expiry.json() as Checkpoint
    expect(rebuilding).toMatchObject({ phase: 'rebuilding', cursor: 'start', sourceId })
    const staged = ledger.commit(page(rebuilding, 1, [row(1, { input: 20 })], true))
    expect(visibleRows(ledger, sourceId)).toMatchObject([{ row_key: olderKey }, { row_key: rowKey, input: 8 }])
    const completed = ledger.commit(page(staged.checkpoint, 2))
    expect(visibleRows(ledger, sourceId)).toMatchObject([{ row_key: rowKey, input: 20 }])
    expect(ledger.getSources().find(source => source.id === sourceId)?.gap).toEqual({ missingRows: 1,
      from: new Date(older).toISOString(), to: new Date(Date.parse(older) + 1).toISOString() })
    expect(ledger.db.query('SELECT row_key FROM usage_rows').all()).toHaveLength(1)

    const reset = ledger.recover({ sourceId, revision: completed.checkpoint.revision, reason: 'cursor_reset' })
    expect(reset).toMatchObject({ phase: 'recovery_required', cursor: completed.checkpoint.cursor })
    expect((await ingest(request('/v1/usage-hub/pages', page(reset, 3), keyA))).status).toBe(409)
    expect(visibleRows(ledger, sourceId)).toHaveLength(1)
    const approval = await manage(request('/api/sources', { revision: ledger.managementSnapshot().revision,
      action: 'rebuild', id: sourceId }))
    expect(approval.status).toBe(200)
    expect(ledger.checkpoint(sourceId)).toMatchObject({ phase: 'rebuilding', cursor: 'start' })
  } finally {
    ledger.db.close()
  }
})

test('reopening a restored database preserves source progress but invalidates stale revisions', async () => {
  const root = await realpath(tmpdir())
  const directory = await mkdtemp(join(root, 'mpu-center-ledger-'))
  const path = join(directory, 'center.sqlite')
  let ledger: CenterLedger | undefined
  try {
    ledger = openCenterLedger(path)
    const sourceId = createSource(ledger, 'Windows A', keyA)
    const ingest = createIngest(ledger)
    const pathPages = '/v1/usage-hub/pages'
    const commit = await ingest(request(pathPages, page(ledger.checkpoint(sourceId), 1, [row(1)]), keyA))
    const before = (await commit.json() as PageReceipt).checkpoint
    const adminRevision = ledger.managementSnapshot().revision
    ledger.db.close()
    ledger = undefined

    ledger = openCenterLedger(path)
    const restored = await (await createIngest(ledger)(request('/v1/usage-hub/checkpoint', undefined, keyA))).json() as Checkpoint
    expect(restored).toMatchObject({ centerId: before.centerId, sourceId, cursor: before.cursor,
      phase: 'sync', lastSyncedAt: before.lastSyncedAt })
    expect(restored.revision).not.toBe(before.revision)
    expect(ledger.managementSnapshot().revision).not.toBe(adminRevision)
    expect(visibleRows(ledger, sourceId)).toHaveLength(1)
    const stale = await createIngest(ledger)(request(pathPages, page(before, 2), keyA))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: { code: 'checkpoint_conflict' } })
  } finally {
    ledger?.db.close()
    const target = await realpath(directory)
    if (dirname(target) !== root || !basename(target).startsWith('mpu-center-ledger-')) throw new Error('unexpected test directory')
    await rm(target, { recursive: true })
  }
})
