import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, openSync } from 'node:fs'
import type { Checkpoint, CursorFailure, PageReceipt, PageSubmission, RecoveryReport, UsageRow } from '../sync/protocol.ts'
import type { OtlpRow } from './otlp.ts'

type CursorPhase = Exclude<Checkpoint['phase'], 'paused'>
type SourceTransport = 'local' | 'legacy' | 'otlp'
type SourcePhase = Checkpoint['phase'] | 'historical' | 'waiting' | 'receiving'
type SourceRow = {
  id: string
  name: string
  enabled: number
  transport: SourceTransport
  phase: CursorPhase
  active_generation: number | null
  write_generation: number
  cursor: string
  revision: string
  last_seq: number
  has_more: number
  last_seen_at: string | null
  last_synced_at: string | null
  last_page_at: string | null
  recovery_reason: CursorFailure | null
  missing_rows: number | null
  gap_from: string | null
  gap_to: string | null
}

type CredentialRow = { source_id: string; digest: string; slot: 'current' | 'pending'; verified: number }
type SourceDescription = SourceRow & { current_key: number; pending_key: number; pending_verified: number }
type Gap = { missingRows: number; from: string | null; to: string | null }

export type SourceStatus = {
  id: string
  name: string
  enabled: boolean
  isLocal: boolean
  transport: SourceTransport
  activeGeneration: number | null
  phase: SourcePhase
  hasMore: boolean
  lastSeenAt: string | null
  lastSyncedAt: string | null
  lastPageAt: string | null
  recoveryReason: CursorFailure | null
  rebuildAllowed: boolean
  gap: Gap | null
  credentials: { current: boolean; pending: boolean; pendingVerified: boolean }
}

export type SourceEdit = { revision: string } & (
  | { action: 'create'; name: string; digest: string; enabled: boolean }
  | { action: 'update'; id: string; name?: string; enabled?: boolean }
  | { action: 'rotate'; id: string; digest: string }
  | { action: 'revoke'; id: string; slot: 'current' | 'pending' | 'all' }
  | { action: 'rebuild'; id: string }
)

export class CenterFailure extends Error {
  constructor(readonly httpStatus: number, readonly code: string) {
    super(code)
  }
}

const initialSchema = `
  CREATE TABLE center_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL,
    manage_revision TEXT NOT NULL
  ) STRICT;
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    revision TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'backfill',
    cursor TEXT NOT NULL DEFAULT 'start',
    last_seq INTEGER NOT NULL DEFAULT 0,
    has_more INTEGER NOT NULL DEFAULT 0,
    active_generation INTEGER,
    write_generation INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    last_synced_at TEXT,
    last_page_at TEXT,
    recovery_reason TEXT,
    missing_rows INTEGER,
    gap_from TEXT,
    gap_to TEXT
  ) STRICT;
  CREATE TABLE credentials (
    digest TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id),
    slot TEXT NOT NULL CHECK (slot IN ('current', 'pending')),
    verified INTEGER NOT NULL DEFAULT 0,
    UNIQUE (source_id, slot)
  ) STRICT;
  CREATE TABLE usage_rows (
    source_id TEXT NOT NULL REFERENCES sources(id),
    generation INTEGER NOT NULL,
    row_key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    t TEXT NOT NULL,
    time_ms INTEGER NOT NULL,
    via TEXT NOT NULL,
    model TEXT NOT NULL,
    handed_on INTEGER NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    reasoning INTEGER NOT NULL,
    cache_unknown INTEGER NOT NULL,
    cost REAL,
    status INTEGER,
    duration_ms INTEGER,
    received_at TEXT NOT NULL,
    PRIMARY KEY (source_id, generation, row_key)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX usage_by_time ON usage_rows (source_id, generation, time_ms DESC, row_key DESC);
  CREATE INDEX usage_by_model ON usage_rows (source_id, generation, model, time_ms DESC, row_key DESC);
`

function initialize(db: Database): string {
  const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version
  if (version !== 0 && version !== 1 && version !== 2) throw new CenterFailure(503, 'ledger_version_unsupported')
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
  db.transaction(() => {
    if (version === 0) {
      db.exec(initialSchema)
      db.run('INSERT INTO center_meta VALUES (1, ?, ?)', [randomUUID(), randomUUID()])
      db.run('INSERT INTO sources (id, name, enabled, revision) VALUES (?, ?, 1, ?)', ['local', '中心本机', randomUUID()])
    }
    if (version < 2) {
      db.exec(`ALTER TABLE sources ADD COLUMN transport TEXT NOT NULL DEFAULT 'legacy'
        CHECK (transport IN ('local', 'legacy', 'otlp'));
        UPDATE sources SET transport = 'local' WHERE id = 'local';
        PRAGMA user_version = 2;`)
    }
    db.run('UPDATE center_meta SET manage_revision = ? WHERE singleton = 1', [randomUUID()])
    db.run('UPDATE sources SET revision = ?', [randomUUID()])
  })()
  const meta = db.query<{ id: string }, []>('SELECT id FROM center_meta WHERE singleton = 1').get()
  if (!meta) throw new CenterFailure(503, 'ledger_invalid')
  return meta.id
}

function protectFile(path: string): void {
  if (path === ':memory:') return
  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (!existing) {
    closeSync(openSync(path, 'wx', 0o600))
    return
  }
  if (!existing.isFile() || (process.platform !== 'win32' && (existing.mode & 0o077) !== 0)) {
    throw new CenterFailure(503, 'ledger_file_unprotected')
  }
}

function sourcePhase(source: SourceRow): SourcePhase {
  if (source.transport === 'legacy') return 'historical'
  if (!source.enabled) return 'paused'
  if (source.transport === 'otlp') return source.active_generation === null ? 'waiting' : 'receiving'
  return source.phase
}

function describe(source: SourceDescription): SourceStatus {
  return {
    id: source.id, name: source.name, enabled: Boolean(source.enabled), isLocal: source.transport === 'local',
    transport: source.transport, activeGeneration: source.active_generation, phase: sourcePhase(source),
    hasMore: source.transport === 'local' && Boolean(source.has_more),
    lastSeenAt: source.last_seen_at, lastSyncedAt: source.last_synced_at, lastPageAt: source.last_page_at,
    recoveryReason: source.recovery_reason,
    rebuildAllowed: source.transport === 'local' && source.phase === 'recovery_required' && source.recovery_reason !== null,
    gap: source.missing_rows === null ? null : { missingRows: source.missing_rows, from: source.gap_from, to: source.gap_to },
    credentials: { current: Boolean(source.current_key), pending: Boolean(source.pending_key),
      pendingVerified: Boolean(source.pending_verified) },
  }
}

function centerStore(db: Database, centerId: string) {
  const getSource = db.query<SourceRow, [string]>('SELECT * FROM sources WHERE id = ?')
  const getCredential = db.query<CredentialRow, [string]>('SELECT * FROM credentials WHERE digest = ?')
  const getSourceCredentials = db.query<CredentialRow, [string]>('SELECT * FROM credentials WHERE source_id = ?')
  const allSources = db.query<SourceDescription, []>(`
    SELECT sources.*, current.digest IS NOT NULL AS current_key,
      pending.digest IS NOT NULL AS pending_key, coalesce(pending.verified, 0) AS pending_verified
    FROM sources
    LEFT JOIN credentials AS current ON current.source_id = sources.id AND current.slot = 'current'
    LEFT JOIN credentials AS pending ON pending.source_id = sources.id AND pending.slot = 'pending'
    ORDER BY sources.id <> 'local', sources.name COLLATE NOCASE, sources.id
  `)
  const upsert = db.query(`
    INSERT INTO usage_rows (source_id, generation, row_key, seq, t, time_ms, via, model, handed_on,
      input, output, cache_read, cache_write, reasoning, cache_unknown, cost, status, duration_ms, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id, generation, row_key) DO UPDATE SET
      seq = excluded.seq, t = excluded.t, time_ms = excluded.time_ms, via = excluded.via, model = excluded.model,
      handed_on = excluded.handed_on, input = excluded.input, output = excluded.output,
      cache_read = excluded.cache_read, cache_write = excluded.cache_write, reasoning = excluded.reasoning,
      cache_unknown = excluded.cache_unknown, cost = excluded.cost, status = excluded.status,
      duration_ms = excluded.duration_ms, received_at = excluded.received_at
    WHERE excluded.seq > usage_rows.seq
  `)
  const remove = db.query('DELETE FROM usage_rows WHERE source_id = ? AND generation = ? AND row_key = ? AND seq < ?')

  function source(id: string): SourceRow {
    const record = getSource.get(id)
    if (!record) throw new CenterFailure(404, 'source_not_found')
    return record
  }

  function checkedOtlpSource(digest: string, expectedSourceId?: string) {
    const credential = getCredential.get(digest)
    if (!credential) throw new CenterFailure(401, 'report_key_invalid')
    if (expectedSourceId !== undefined && credential.source_id !== expectedSourceId) {
      throw new CenterFailure(403, 'source_mismatch')
    }
    const record = source(credential.source_id)
    if (record.transport !== 'otlp') throw new CenterFailure(403, 'source_transport_inactive')
    if (!record.enabled) throw new CenterFailure(403, 'source_paused')
    return { credential, record }
  }

  function cursorSource(sourceId: string): SourceRow {
    const record = source(sourceId)
    if (record.transport !== 'local') throw new CenterFailure(403, 'source_transport_inactive')
    return record
  }

  function checkpoint(sourceId: string): Checkpoint {
    const record = cursorSource(sourceId)
    return { centerId, sourceId, revision: record.revision, cursor: record.cursor,
      phase: record.enabled ? record.phase : 'paused', hasMore: Boolean(record.has_more), lastSyncedAt: record.last_synced_at }
  }

  function storeUsage(sourceId: string, generation: number, row: UsageRow | OtlpRow, seq: number, now: string) {
    return upsert.run(sourceId, generation, row.rowKey, seq, row.t, Date.parse(row.t), row.via, row.model,
      Number(row.handedOn), row.input, row.output, row.cacheRead, row.cacheWrite, row.reasoning,
      Number(row.cacheUnknown), row.cost, row.status, row.durationMs, now).changes
  }

  const commitOtlp = db.transaction((digest: string, rows: readonly OtlpRow[], expectedSourceId?: string): void => {
    const { credential, record } = checkedOtlpSource(digest, expectedSourceId)
    if (rows.length === 0) return
    const generation = record.active_generation ?? record.write_generation
    const now = new Date().toISOString()
    for (const row of rows) storeUsage(record.id, generation, row, 0, now)
    db.run('UPDATE sources SET active_generation = ?, last_seen_at = ?, last_page_at = ? WHERE id = ?',
      [generation, now, now, record.id])
    if (credential.slot === 'pending' && !credential.verified) {
      db.run('UPDATE credentials SET verified = 1 WHERE digest = ?', [digest])
    }
  }).immediate

  function writableSource(sourceId: string, revision: string): SourceRow {
    const record = cursorSource(sourceId)
    if (!record.enabled) throw new CenterFailure(403, 'source_paused')
    if (record.revision !== revision) throw new CenterFailure(409, 'checkpoint_conflict')
    if (record.phase === 'recovery_required') throw new CenterFailure(409, 'source_recovery_required')
    return record
  }

  function beginRebuild(record: SourceRow, reason: CursorFailure): void {
    if (record.write_generation !== record.active_generation) {
      db.run('DELETE FROM usage_rows WHERE source_id = ? AND generation = ?', [record.id, record.write_generation])
    }
    db.run(`UPDATE sources SET revision = ?, cursor = 'start', last_seq = 0, has_more = 1,
      phase = 'rebuilding', recovery_reason = ?, write_generation = ? WHERE id = ?`,
    [randomUUID(), reason, (record.active_generation ?? 0) + 1, record.id])
  }

  function compareGenerations(sourceId: string, oldGeneration: number | null, newGeneration: number): Gap {
    if (oldGeneration === null) return { missingRows: 0, from: null, to: null }
    const missing = db.query<{ count: number; min_ms: number | null; max_ms: number | null }, [string, number, number]>(`
      SELECT count(*) AS count, min(old.time_ms) AS min_ms, max(old.time_ms) AS max_ms FROM usage_rows AS old
      WHERE old.source_id = ? AND old.generation = ? AND NOT EXISTS (
        SELECT 1 FROM usage_rows AS fresh WHERE fresh.source_id = old.source_id
          AND fresh.generation = ? AND fresh.row_key = old.row_key
      )
    `).get(sourceId, oldGeneration, newGeneration)
    if (!missing) throw new CenterFailure(503, 'ledger_invalid')
    return { missingRows: missing.count, from: missing.min_ms === null ? null : new Date(missing.min_ms).toISOString(),
      to: missing.max_ms === null ? null : new Date(missing.max_ms + 1).toISOString() }
  }

  const commit = db.transaction((page: PageSubmission): PageReceipt => {
    const { sourceId, revision, nextCursor, hasMore, upserts, removals } = page
    const record = writableSource(sourceId, revision)
    const changes = [...upserts, ...removals]
    if (nextCursor === record.cursor && (hasMore || changes.length > 0)) {
      throw new CenterFailure(400, 'invalid_page_progress')
    }
    if (changes.some(change => change.seq <= record.last_seq)) throw new CenterFailure(400, 'invalid_page_progress')
    const lastSeq = Math.max(record.last_seq, ...changes.map(change => change.seq))
    const generation = record.write_generation
    const now = new Date().toISOString()
    let upserted = 0
    let removed = 0
    for (const row of upserts) upserted += storeUsage(sourceId, generation, row, row.seq, now)
    for (const row of removals) removed += remove.run(sourceId, generation, row.rowKey, row.seq).changes
    const publish = !hasMore && record.phase !== 'sync'
    const gap = publish && record.phase === 'rebuilding'
      ? compareGenerations(sourceId, record.active_generation, generation)
      : { missingRows: record.missing_rows, from: record.gap_from, to: record.gap_to }
    db.run(`UPDATE sources SET revision = ?, cursor = ?, last_seq = ?, has_more = ?, last_page_at = ?, last_seen_at = ?,
      last_synced_at = ?, phase = ?, active_generation = ?, recovery_reason = ?,
      missing_rows = ?, gap_from = ?, gap_to = ? WHERE id = ?`,
    [randomUUID(), nextCursor, lastSeq, Number(hasMore), now, now, hasMore ? record.last_synced_at : now,
      publish ? 'sync' : record.phase, publish ? generation : record.active_generation,
      publish ? null : record.recovery_reason, gap.missingRows, gap.from, gap.to, sourceId])
    if (publish) db.run('DELETE FROM usage_rows WHERE source_id = ? AND generation <> ?', [sourceId, generation])
    return { checkpoint: checkpoint(sourceId), upserted, removed }
  })

  const recover = db.transaction((report: RecoveryReport): Checkpoint => {
    const record = writableSource(report.sourceId, report.revision)
    if (report.reason === 'cursor_expired') {
      beginRebuild(record, report.reason)
    } else {
      db.run('UPDATE sources SET phase = ?, recovery_reason = ?, revision = ? WHERE id = ?',
        ['recovery_required', report.reason, randomUUID(), report.sourceId])
    }
    db.run('UPDATE sources SET last_seen_at = ? WHERE id = ?', [new Date().toISOString(), report.sourceId])
    return checkpoint(report.sourceId)
  })

  function getSources(): readonly SourceStatus[] {
    return allSources.all().map(describe)
  }

  function managementRevision(): string {
    const meta = db.query<{ manage_revision: string }, []>('SELECT manage_revision FROM center_meta WHERE singleton = 1').get()
    if (!meta) throw new CenterFailure(503, 'ledger_invalid')
    return meta.manage_revision
  }

  function managementSnapshot() {
    return { revision: managementRevision(), sources: getSources() }
  }

  function addCredential(sourceId: string, slot: CredentialRow['slot'], digest: string): void {
    if (getCredential.get(digest)) throw new CenterFailure(409, 'credential_in_use')
    db.run('INSERT INTO credentials (digest, source_id, slot) VALUES (?, ?, ?)', [digest, sourceId, slot])
  }

  const editSource = db.transaction((edit: SourceEdit) => {
    if (edit.revision !== managementRevision()) throw new CenterFailure(409, 'source_revision_conflict')
    if (edit.action === 'create') {
      const id = randomUUID()
      db.run("INSERT INTO sources (id, name, enabled, revision, transport) VALUES (?, ?, ?, ?, 'otlp')",
        [id, edit.name, Number(edit.enabled), randomUUID()])
      addCredential(id, 'current', edit.digest)
    } else {
      const record = source(edit.id)
      if (record.transport === 'legacy') throw new CenterFailure(403, 'source_transport_inactive')
      if (edit.id === 'local' && edit.action !== 'rebuild') throw new CenterFailure(400, 'invalid_source')
      switch (edit.action) {
        case 'update':
          db.run('UPDATE sources SET name = ?, enabled = ?, revision = ? WHERE id = ?',
            [edit.name ?? record.name, Number(edit.enabled ?? record.enabled), randomUUID(), edit.id])
          break
        case 'rotate': {
          const credentials = getSourceCredentials.all(edit.id)
          if (credentials.some(credential => credential.slot === 'pending')) throw new CenterFailure(409, 'pending_key_exists')
          addCredential(edit.id, credentials.length > 0 ? 'pending' : 'current', edit.digest)
          break
        }
        case 'revoke': {
          if (edit.slot === 'all') {
            db.run('DELETE FROM credentials WHERE source_id = ?', [edit.id])
            break
          }
          const pending = getSourceCredentials.all(edit.id).find(credential => credential.slot === 'pending')
          if (edit.slot === 'current' && pending && !pending.verified) throw new CenterFailure(409, 'pending_key_unverified')
          db.run('DELETE FROM credentials WHERE source_id = ? AND slot = ?', [edit.id, edit.slot])
          if (edit.slot === 'current' && pending) db.run('UPDATE credentials SET slot = ? WHERE digest = ?', ['current', pending.digest])
          break
        }
        case 'rebuild':
          if (record.transport !== 'local' || record.phase !== 'recovery_required' || record.recovery_reason === null) {
            throw new CenterFailure(409, 'source_rebuild_not_required')
          }
          beginRebuild(record, record.recovery_reason)
          break
      }
    }
    db.run('UPDATE center_meta SET manage_revision = ? WHERE singleton = 1', [randomUUID()])
    return managementSnapshot()
  })

  return {
    db, authenticateOtlp: (digest: string) => checkedOtlpSource(digest).record.id, commitOtlp,
    checkpoint, commit, recover, getSources, managementSnapshot, editSource,
  }
}

export function openCenterLedger(path: string) {
  protectFile(path)
  const db = new Database(path)
  try {
    return centerStore(db, initialize(db))
  } catch (error) {
    db.close()
    throw error
  }
}

export type CenterLedger = ReturnType<typeof openCenterLedger>
