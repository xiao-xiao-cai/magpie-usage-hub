import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createDashboard } from '../../src/center/dashboard.ts'
import { type CenterLedger, openCenterLedger } from '../../src/center/ledger.ts'
import type { OtlpRow } from '../../src/center/otlp.ts'
import { createSourceManagement } from '../../src/center/sources.ts'
import type { Checkpoint, PageSubmission, UsageRow } from '../../src/sync/protocol.ts'

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

function request(path: string, body?: object): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
}

function createSource(ledger: CenterLedger, name: string, key: string): string {
  const result = ledger.editSource({ revision: ledger.managementSnapshot().revision, action: 'create',
    name, digest: digest(key), enabled: true })
  return result.sources.find(source => source.name === name)!.id
}

const fixtureRow = { rowKey, t: recent, via: 'through', model: 'synthetic-model', handedOn: false,
  input: 8, output: 12, cacheRead: 0, cacheWrite: 0, reasoning: 0, cacheUnknown: false,
  cost: 0, status: 200, durationMs: 100 } as const

function row(seq: number, patch: Partial<UsageRow> = {}): UsageRow {
  return { ...fixtureRow, seq, ...patch }
}

function otlpRow(patch: Partial<OtlpRow> = {}): OtlpRow {
  return { ...fixtureRow, ...patch }
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
    expect(sources).toMatchObject([{ id: 'local', isLocal: true, transport: 'local' },
      { name: draft.name, isLocal: false, transport: 'otlp', phase: 'waiting',
      credentials: { current: true, pending: false, pendingVerified: false } }])
    const id = sources[1].id
    const edit = async (action: object) => manage(request(endpoint, { revision: (await get()).revision, ...action }))
    expect(await (await edit({ action: 'create', name: '重复摘要', digest: digest(keyA) })).json()).toEqual({
      error: { code: 'credential_in_use' },
    })
    expect((await get()).sources).toHaveLength(2)

    expect((await edit({ action: 'rotate', id, digest: digest(keyNext) })).status).toBe(200)
    expect(ledger.authenticateOtlp(digest(keyNext))).toBe(id)
    ledger.commitOtlp(digest(keyNext), [])
    expect((await get()).sources[1]).toMatchObject({ phase: 'waiting', lastSeenAt: null, lastPageAt: null,
      credentials: { current: true, pending: true, pendingVerified: false } })
    expect((await edit({ action: 'revoke', id, slot: 'current' })).status).toBe(409)
    ledger.commitOtlp(digest(keyNext), [otlpRow()])
    expect((await get()).sources[1]).toMatchObject({ phase: 'receiving', lastSeenAt: expect.any(String),
      lastPageAt: expect.any(String), lastSyncedAt: null,
      credentials: { current: true, pending: true, pendingVerified: true } })
    expect((await edit({ action: 'revoke', id, slot: 'current' })).status).toBe(200)
    expect(() => ledger.authenticateOtlp(digest(keyA))).toThrow('report_key_invalid')
    expect(ledger.authenticateOtlp(digest(keyNext))).toBe(id)
    expect((await edit({ action: 'update', id, name: '合成新名称', enabled: false })).status).toBe(200)
    expect((await get()).sources[1]).toMatchObject({ id, phase: 'paused' })
    expect(() => ledger.authenticateOtlp(digest(keyNext))).toThrow('source_paused')
    expect(() => ledger.commitOtlp(digest(keyNext), [otlpRow()])).toThrow('source_paused')
    expect((await edit({ action: 'revoke', id, slot: 'all' })).status).toBe(200)
    expect(() => ledger.authenticateOtlp(digest(keyNext))).toThrow('report_key_invalid')
    expect(visibleRows(ledger, id)).toHaveLength(1)
  } finally {
    ledger.db.close()
  }
})

test('source creation reconciles a client UUID through the management snapshot', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const endpoint = '/api/sources'
    const manage = createSourceManagement(ledger)
    const snapshot = async () => (await manage(request(endpoint))).json()
    const create = (edit: object) => manage(request(endpoint, { action: 'create', name: 'Same name', digest: digest(keyA), ...edit }))
    const initial = await snapshot()
    for (const invalid of ['local', 'invalid', '46b0d167-eabe-7800-aa21-8109e50f55c3', null]) {
      const rejected = await create({ revision: initial.revision, id: invalid })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({ error: { code: 'invalid_source' } })
    }
    const id = crypto.randomUUID()
    const first = await create({ revision: initial.revision, id })
    expect(first.status).toBe(201)
    await first.text()
    const recovered = await snapshot()
    expect(recovered.sources).toMatchObject([{ id: 'local' }, { id, name: 'Same name' }])
    const replay = await create({ revision: initial.revision, id })
    expect(replay.status).toBe(409)
    expect(await replay.json()).toEqual({ error: { code: 'source_revision_conflict' } })
    const collision = await create({ revision: recovered.revision, id, digest: digest(keyB) })
    expect(collision.status).toBe(409)
    expect(await collision.json()).toEqual({ error: { code: 'source_id_in_use' } })
    expect(await snapshot()).toEqual(recovered)
    expect(ledger.authenticateOtlp(digest(keyA))).toBe(id)
    const secondId = crypto.randomUUID()
    const second = await create({ revision: recovered.revision, id: secondId, digest: digest(keyB) })
    expect(second.status).toBe(201)
    const { sources } = await snapshot()
    expect(sources.filter((source: { name: string }) => source.name === 'Same name').map((source: { id: string }) => source.id).sort())
      .toEqual([id, secondId].sort())
    expect(ledger.authenticateOtlp(digest(keyB))).toBe(secondId)
  } finally {
    ledger.db.close()
  }
})

test('OTLP retries preserve the first snapshot and isolate identical span identifiers by source', () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const sourceA = createSource(ledger, 'Windows A', keyA)
    const sourceB = createSource(ledger, 'Windows B', keyB)
    expect(() => ledger.checkpoint(sourceA)).toThrow('source_transport_inactive')
    expect(() => ledger.commit({ ...page(ledger.checkpoint('local'), 1, [row(1)]), sourceId: sourceA })).toThrow('source_transport_inactive')
    ledger.commitOtlp(digest(keyA), [otlpRow(), otlpRow()])
    const initial = ledger.getSources().find(source => source.id === sourceA)
    expect(initial).toMatchObject({ phase: 'receiving', activeGeneration: 1 })
    ledger.commitOtlp(digest(keyB), [otlpRow({ input: 99 })])
    ledger.commitOtlp(digest(keyA), [otlpRow({ input: 18, t: older }), otlpRow({ rowKey: olderKey, t: older, via: 'session' })])
    expect(ledger.getSources().find(source => source.id === sourceA)?.activeGeneration).toBe(initial?.activeGeneration)
    expect(visibleRows(ledger, sourceA)).toEqual([
      { row_key: olderKey, seq: 0, t: older, time_ms: Date.parse(older), input: 8 },
      { row_key: rowKey, seq: 0, t: recent, time_ms: Date.parse(recent), input: 8 },
    ])
    expect(visibleRows(ledger, sourceB)).toMatchObject([{ row_key: rowKey, input: 99 }])
    expect(visibleRows(ledger, 'local')).toEqual([])
  } finally {
    ledger.db.close()
  }
})

test('a failed local checkpoint update rolls back the page and retry publishes it once', () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const checkpoint = ledger.checkpoint('local')
    const payload = page(checkpoint, 1, [row(1)])
    ledger.db.exec(`CREATE TEMP TRIGGER fixture_write_failure BEFORE UPDATE OF cursor ON sources
      BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;`)
    expect(() => ledger.commit(payload)).toThrow('fixture write failure')
    expect(ledger.db.query('SELECT row_key FROM usage_rows').all()).toEqual([])
    expect(ledger.checkpoint('local')).toEqual(checkpoint)
    ledger.db.exec('DROP TRIGGER fixture_write_failure')
    expect(ledger.commit(payload).upserted).toBe(1)
    expect(() => ledger.commit(payload)).toThrow('checkpoint_conflict')
    expect(visibleRows(ledger, 'local')).toHaveLength(1)
  } finally {
    ledger.db.close()
  }
})

test('local backfill publishes on the last page and applies later corrections and removals', () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const sourceId = 'local'
    const staged = ledger.commit(page(ledger.checkpoint(sourceId), 1, [row(1)], true))
    expect(staged.checkpoint).toMatchObject({ phase: 'backfill', lastSyncedAt: null })
    expect(visibleRows(ledger, sourceId)).toEqual([])
    const published = ledger.commit(page(staged.checkpoint, 2))
    expect(published.checkpoint).toMatchObject({ phase: 'sync', lastSyncedAt: expect.any(String) })
    const correction = ledger.commit(page(published.checkpoint, 3, [row(3, { input: 18 }),
      row(2, { rowKey: olderKey, t: older, via: 'direct' })]))
    expect(correction.upserted).toBe(2)
    expect(visibleRows(ledger, sourceId)).toEqual([
      { row_key: olderKey, seq: 2, t: older, time_ms: Date.parse(older), input: 8 },
      { row_key: rowKey, seq: 3, t: recent, time_ms: Date.parse(recent), input: 18 },
    ])
    const deletion = { ...page(correction.checkpoint, 4), removals: [{ rowKey, seq: 4 }] }
    expect(ledger.commit(deletion).removed).toBe(1)
    expect(() => ledger.commit(page(ledger.checkpoint(sourceId), 5, [row(3)]))).toThrow('invalid_page_progress')
    expect(visibleRows(ledger, sourceId)).toMatchObject([{ row_key: olderKey }])
  } finally {
    ledger.db.close()
  }
})

test('OTLP commit rechecks revocation and rolls usage, contact and key verification back together', () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const sourceA = createSource(ledger, 'Windows A', keyA)
    const sourceB = createSource(ledger, 'Windows B', keyB)
    expect(ledger.authenticateOtlp(digest(keyA))).toBe(sourceA)
    ledger.editSource({ revision: ledger.managementSnapshot().revision, action: 'revoke', id: sourceA, slot: 'all' })
    expect(() => ledger.commitOtlp(digest(keyA), [otlpRow()], sourceA)).toThrow('report_key_invalid')
    const reassigned = createSource(ledger, 'Windows C', keyA)
    expect(ledger.authenticateOtlp(digest(keyA))).toBe(reassigned)
    expect(() => ledger.commitOtlp(digest(keyA), [otlpRow()], sourceA)).toThrow('source_mismatch')
    expect(visibleRows(ledger, sourceA)).toEqual([])
    ledger.editSource({ revision: ledger.managementSnapshot().revision, action: 'rotate', id: sourceB, digest: digest(keyNext) })
    ledger.db.exec(`CREATE TEMP TRIGGER fixture_write_failure BEFORE UPDATE OF verified ON credentials
      WHEN NEW.slot = 'pending' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;`)
    expect(() => ledger.commitOtlp(digest(keyNext), [otlpRow()])).toThrow('fixture write failure')
    expect(ledger.db.query('SELECT row_key FROM usage_rows').all()).toEqual([])
    expect(ledger.getSources().find(source => source.id === sourceB)).toMatchObject({ phase: 'waiting', lastPageAt: null,
      lastSeenAt: null, activeGeneration: null, credentials: { pendingVerified: false } })
    ledger.db.exec('DROP TRIGGER fixture_write_failure')
    ledger.commitOtlp(digest(keyNext), [otlpRow()])
    expect(ledger.getSources().find(source => source.id === sourceB)).toMatchObject({ phase: 'receiving',
      credentials: { pendingVerified: true } })
    expect(visibleRows(ledger, sourceB)).toHaveLength(1)
  } finally {
    ledger.db.close()
  }
})

test('recovery stages a replacement, records missing events, and requires approval for a reset', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const sourceId = 'local'
    const manage = createSourceManagement(ledger)
    const first = ledger.commit(page(ledger.checkpoint(sourceId), 2, [row(1, { rowKey: olderKey, t: older }), row(2)]))
    const rebuilding = ledger.recover({ sourceId, revision: first.checkpoint.revision, reason: 'cursor_expired' })
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
    expect(() => ledger.commit(page(reset, 3))).toThrow('source_recovery_required')
    expect(visibleRows(ledger, sourceId)).toHaveLength(1)
    const approval = await manage(request('/api/sources', { revision: ledger.managementSnapshot().revision,
      action: 'rebuild', id: sourceId }))
    expect(approval.status).toBe(200)
    expect(ledger.checkpoint(sourceId)).toMatchObject({ phase: 'rebuilding', cursor: 'start' })
  } finally {
    ledger.db.close()
  }
})

test('schema 1 migration preserves published legacy history and local cursor progress', async () => {
  const root = await realpath(tmpdir())
  const directory = await mkdtemp(join(root, 'mpu-center-ledger-'))
  const path = join(directory, 'center.sqlite')
  let ledger: CenterLedger | undefined
  try {
    ledger = openCenterLedger(path)
    const legacyId = createSource(ledger, 'Windows A', keyA)
    ledger.commitOtlp(digest(keyA), [otlpRow({ input: 34 })])
    ledger.db.run("UPDATE sources SET phase = 'sync', cursor = ?, last_seq = 1 WHERE id = ?", ['fixture-remote-cursor', legacyId])
    ledger.db.run('UPDATE usage_rows SET seq = 1 WHERE source_id = ?', [legacyId])
    const before = ledger.commit(page(ledger.checkpoint('local'), 1, [row(1)])).checkpoint
    const adminRevision = ledger.managementSnapshot().revision
    ledger.db.exec('ALTER TABLE sources DROP COLUMN transport; PRAGMA user_version = 1;')
    ledger.db.close()
    ledger = undefined

    const migrated = ledger = openCenterLedger(path)
    const restored = migrated.checkpoint('local')
    expect(restored).toMatchObject({ centerId: before.centerId, sourceId: 'local', cursor: before.cursor,
      phase: 'sync', lastSyncedAt: before.lastSyncedAt })
    expect(restored.revision).not.toBe(before.revision)
    expect(migrated.managementSnapshot().revision).not.toBe(adminRevision)
    expect(migrated.db.query('PRAGMA user_version').get()).toEqual({ user_version: 2 })
    expect(visibleRows(migrated, 'local')).toHaveLength(1)
    expect(() => migrated.commit(page(before, 2))).toThrow('checkpoint_conflict')
    expect(migrated.getSources().find(source => source.id === legacyId)).toMatchObject({ transport: 'legacy',
      phase: 'historical', credentials: { current: true }, rebuildAllowed: false })
    expect(() => migrated.authenticateOtlp(digest(keyA))).toThrow('source_transport_inactive')
    expect(() => migrated.commitOtlp(digest(keyA), [otlpRow()])).toThrow('source_transport_inactive')
    expect(() => migrated.editSource({ revision: migrated.managementSnapshot().revision, action: 'update',
      id: legacyId, name: 'changed' })).toThrow('source_transport_inactive')
    expect(visibleRows(migrated, legacyId)).toMatchObject([{ row_key: rowKey, input: 34 }])
    const dashboard = createDashboard(migrated, 'UTC')
    const query = new URL('http://127.0.0.1/api/usage')
    query.search = new URLSearchParams({ sourceId: legacyId, from: '2026-11-27T00:00:00Z', to: '2026-11-28T00:00:00Z' }).toString()
    const response = await dashboard(query, new AbortController().signal)
    expect(await response.json()).toMatchObject({ sources: [{ transport: 'legacy', freshness: 'historical', totals: { calls: 1, input: 34 } }] })
    const newSource = createSource(migrated, 'Windows B', keyB)
    expect(migrated.authenticateOtlp(digest(keyB))).toBe(newSource)
  } finally {
    ledger?.db.close()
    const target = await realpath(directory)
    if (dirname(target) !== root || !basename(target).startsWith('mpu-center-ledger-')) throw new Error('unexpected test directory')
    await rm(target, { recursive: true })
  }
})
