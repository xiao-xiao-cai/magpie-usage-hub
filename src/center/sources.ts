import type { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isProviderId } from '../options.ts'
import { failure, isRecord, isSourceId, jsonReply, readJsonBody } from './http.ts'

const pairingTtlMs = 15 * 60_000

const configColumns = 'id, source_caller_key_id, source_provider_id, enabled, poll_interval_sec'
const descriptionColumns = `${configColumns}, name, revision, credential_digest IS NOT NULL AS paired,
  pairing_expires_at, last_seen_at, last_report_at`

type StoredConfig = {
  id: string
  source_caller_key_id: string
  source_provider_id: string
  enabled: 0 | 1
  poll_interval_sec: number
}

type StoredSource = StoredConfig & {
  name: string
  revision: number
  paired: 0 | 1
  pairing_expires_at: number | null
  last_seen_at: number | null
  last_report_at: number | null
}

type SourceSettings = { enabled: boolean; pollIntervalSec: number }
type SourceDraft = SourceSettings & { name: string; sourceCallerKeyId: string; sourceProviderId: string }

export function createSourceTable(database: Database): void {
  database.exec(`
    CREATE TABLE managed_sources (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      source_caller_key_id TEXT NOT NULL,
      source_provider_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      poll_interval_sec INTEGER NOT NULL CHECK (poll_interval_sec BETWEEN 5 AND 900),
      revision INTEGER NOT NULL DEFAULT 1,
      pairing_digest TEXT UNIQUE,
      pairing_expires_at INTEGER,
      credential_digest TEXT UNIQUE,
      last_seen_at INTEGER,
      last_report_at INTEGER,
      CHECK ((credential_digest IS NULL) = (pairing_digest IS NOT NULL)),
      CHECK ((pairing_digest IS NULL) = (pairing_expires_at IS NULL))
    ) STRICT;
  `)
}

export function checkSourceTable(database: Database): void {
  database.query(`SELECT ${descriptionColumns}, pairing_digest, credential_digest FROM managed_sources LIMIT 0`).all()
}

export function credentialDigest(secret: string): string {
  return createHash('sha256').update(secret, 'ascii').digest('hex')
}

function sourceConfig(stored: StoredConfig) {
  return {
    sourceInstanceId: stored.id,
    sourceCallerKeyId: stored.source_caller_key_id,
    sourceProviderId: stored.source_provider_id,
    enabled: stored.enabled === 1,
    pollIntervalSec: stored.poll_interval_sec,
  }
}

function isoTime(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString()
}

function describeSource(stored: StoredSource) {
  const { sourceInstanceId: id, ...settings } = sourceConfig(stored)
  return {
    id, name: stored.name, ...settings, revision: stored.revision, paired: stored.paired === 1,
    pairingExpiresAt: isoTime(stored.pairing_expires_at), lastSeenAt: isoTime(stored.last_seen_at),
    lastReportAt: isoTime(stored.last_report_at),
  }
}

export function createSourceRegistry(database: Database) {
  const list = database.query<StoredSource, []>(`SELECT ${descriptionColumns} FROM managed_sources ORDER BY name, id`)
  const find = database.query<StoredSource, [string]>(`SELECT ${descriptionColumns} FROM managed_sources WHERE id = ?`)
  const reporter = database.query<StoredConfig, [string]>(`SELECT ${configColumns} FROM managed_sources WHERE credential_digest = ?`)
  const add = database.query<StoredSource, [string, string, string, string, boolean, number, string, number]>(`
    INSERT INTO managed_sources (id, name, source_caller_key_id, source_provider_id, enabled, poll_interval_sec,
      pairing_digest, pairing_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${descriptionColumns}
  `)
  const edit = database.query<StoredSource, [boolean, number, string, number]>(`
    UPDATE managed_sources SET enabled = ?, poll_interval_sec = ?, revision = revision + 1
    WHERE id = ? AND revision = ? RETURNING ${descriptionColumns}
  `)
  const renew = database.query<StoredSource, [string, number, string, number]>(`
    UPDATE managed_sources SET pairing_digest = ?, pairing_expires_at = ?, revision = revision + 1
    WHERE id = ? AND revision = ? AND credential_digest IS NULL RETURNING ${descriptionColumns}
  `)
  const pending = database.query<{ id: string }, [string, number]>(`
    SELECT id FROM managed_sources WHERE pairing_digest = ? AND pairing_expires_at > ?
  `)
  const claim = database.query(`
    UPDATE managed_sources SET credential_digest = ?, pairing_digest = NULL, pairing_expires_at = NULL,
      revision = revision + 1 WHERE id = ?
  `)
  const seen = database.query<StoredConfig, [number, string]>(`
    UPDATE managed_sources SET last_seen_at = ? WHERE credential_digest = ? RETURNING ${configColumns}
  `)
  const reported = database.query('UPDATE managed_sources SET last_report_at = ? WHERE id = ?')

  return {
    list: () => list.all().map(describeSource),
    find: (id: string) => find.get(id),
    reporter: (digest: string) => reporter.get(digest),
    add({ name, sourceCallerKeyId, sourceProviderId, enabled, pollIntervalSec }: SourceDraft) {
      const pairingCode = randomBytes(32).toString('hex')
      const row = add.get(randomUUID(), name, sourceCallerKeyId, sourceProviderId, enabled, pollIntervalSec,
        credentialDigest(pairingCode), Date.now() + pairingTtlMs)
      if (!row) throw new Error('source_write_failed')
      return { source: describeSource(row), pairingCode }
    },
    edit(id: string, revision: number, { enabled, pollIntervalSec }: SourceSettings) {
      const row = edit.get(enabled, pollIntervalSec, id, revision)
      return row ? { source: describeSource(row) } : null
    },
    renew(id: string, revision: number) {
      const pairingCode = randomBytes(32).toString('hex')
      const row = renew.get(credentialDigest(pairingCode), Date.now() + pairingTtlMs, id, revision)
      return row ? { source: describeSource(row), pairingCode } : null
    },
    pair: database.transaction((codeDigest: string, nodeDigest: string) => {
      const source = pending.get(codeDigest, Date.now())
      if (!source) return 'invalid_pairing_code'
      if (codeDigest === nodeDigest || reporter.get(nodeDigest)) return 'credential_conflict'
      claim.run(nodeDigest, source.id)
      return 'paired'
    }).immediate,
    config(digest: string) {
      const row = seen.get(Date.now(), digest)
      return row ? sourceConfig(row) : null
    },
    markReport: (id: string) => reported.run(Date.now(), id),
  }
}

export type SourceRegistry = ReturnType<typeof createSourceRegistry>

function hasFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}

function validSourceName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value === value.trim() && [...value].length <= 80
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function readSettings(value: Record<string, unknown>): SourceSettings | null {
  const { enabled, pollIntervalSec } = value
  if (typeof enabled !== 'boolean' || typeof pollIntervalSec !== 'number' || !Number.isInteger(pollIntervalSec)
    || pollIntervalSec < 5 || pollIntervalSec > 900) return null
  return { enabled, pollIntervalSec }
}

export function createSourceManagement(sources: SourceRegistry) {
  const collectionPath = '/api/sources'
  const settingsPath = '/api/sources/settings'
  const pairingPath = '/api/sources/pairing'
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (pathname !== collectionPath && pathname !== settingsPath && pathname !== pairingPath) {
      return failure(404, 'not_found')
    }
    try {
      if (pathname === collectionPath && request.method === 'GET') return jsonReply({ sources: sources.list() })
      if (request.method !== 'POST') return failure(405, 'method_not_allowed')
      const body = await readJsonBody(request, 4096, 'invalid_source', 'request_too_large')
      if (body instanceof Response) return body
      const { value } = body
      if (!isRecord(value)) return failure(400, 'invalid_source')
      if (pathname === collectionPath) {
        const { name, sourceCallerKeyId, sourceProviderId } = value
        const settings = readSettings(value)
        if (!hasFields(value, ['name', 'sourceCallerKeyId', 'sourceProviderId', 'enabled', 'pollIntervalSec'])
          || !settings || !validSourceName(name) || typeof sourceCallerKeyId !== 'string'
          || sourceCallerKeyId === 'none' || !/^[A-Za-z0-9_-]{1,128}$/u.test(sourceCallerKeyId)
          || /\s/u.test(sourceCallerKeyId) || !isProviderId(sourceProviderId)) return failure(400, 'invalid_source')
        return jsonReply(sources.add({ name, sourceCallerKeyId, sourceProviderId, ...settings }), 201)
      }

      const { id, revision } = value
      if (!isSourceId(id) || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
        return failure(400, 'invalid_source')
      }
      if (pathname === settingsPath) {
        const settings = readSettings(value)
        if (!hasFields(value, ['id', 'revision', 'enabled', 'pollIntervalSec']) || !settings) {
          return failure(400, 'invalid_source')
        }
        const result = sources.edit(id, revision, settings)
        if (result) return jsonReply(result)
      } else {
        if (!hasFields(value, ['id', 'revision'])) return failure(400, 'invalid_source')
        const result = sources.renew(id, revision)
        if (result) return jsonReply(result)
      }
      const current = sources.find(id)
      if (!current) return failure(404, 'source_not_found')
      const alreadyPaired = pathname === pairingPath && current.revision === revision && current.paired === 1
      return failure(409, alreadyPaired ? 'source_already_paired' : 'source_conflict')
    } catch {
      return failure(503, 'sources_unavailable')
    }
  }
}
