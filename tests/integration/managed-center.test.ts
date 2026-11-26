import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createDashboard } from '../../src/center/dashboard.ts'
import { serveIngest } from '../../src/center/ingest.ts'
import { openCenterLedger } from '../../src/center/ledger.ts'
import { createSourceManagement, createSourceRegistry, credentialDigest } from '../../src/center/sources.ts'
import type { ReportRow } from '../../src/sync/mapping.ts'

const sourcePath = '/api/sources'
const settingsPath = '/api/sources/settings'
const renewPath = '/api/sources/pairing'
const pairPath = '/v1/magpie/usage/pair'
const configPath = '/v1/magpie/usage/config'
const reportsPath = '/v1/magpie/usage/requests'
const directoryPrefix = 'mpu-managed-center-test-'
const fixtureDraft = {
  name: '合成来源', sourceCallerKeyId: 'dedicated_test', sourceProviderId: 'fixture-provider',
  enabled: true, pollIntervalSec: 60,
}

let scratchRoot: string
let directory: string
let dbPath: string
let database: ReturnType<typeof openCenterLedger>
let server: ReturnType<typeof serveIngest>
let manage: ReturnType<typeof createSourceManagement>

function restart(keyFile?: string) {
  database = openCenterLedger(dbPath)
  const sources = createSourceRegistry(database)
  manage = createSourceManagement(sources)
  server = serveIngest(database, keyFile, 0, '127.0.0.1', sources)
}

beforeEach(async () => {
  scratchRoot = await realpath(tmpdir())
  directory = await mkdtemp(join(scratchRoot, directoryPrefix))
  dbPath = join(directory, 'usage.sqlite')
  restart()
})

afterEach(async () => {
  await server.stop(true)
  database.close(true)
  const target = await realpath(directory)
  if (dirname(target) !== scratchRoot || !basename(target).startsWith(directoryPrefix)) {
    throw new Error('unexpected managed center test directory')
  }
  await rm(target, { recursive: true })
})

function jsonPost(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function admin(path = sourcePath, body?: unknown) {
  return manage(new Request(new URL(path, server.url), body === undefined ? {} : jsonPost(body)))
}

function accessNode(path: string, key: string, body?: unknown) {
  const options = body === undefined ? {} : jsonPost(body)
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${key}`)
  return fetch(new URL(path, server.url), { ...options, headers, signal: AbortSignal.timeout(4_000) })
}

function newKey() {
  return randomBytes(32).toString('hex')
}

function pair(code: string, key: string) {
  return accessNode(pairPath, code, { credentialDigest: createHash('sha256').update(key).digest('hex') })
}

async function createSource(overrides: Partial<typeof fixtureDraft> = {}) {
  const response = await admin(sourcePath, { ...fixtureDraft, ...overrides })
  expect(response.status).toBe(201)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return response.json()
}

function report(sourceId: string, index: number, provider = fixtureDraft.sourceProviderId): ReportRow {
  const digest = index.toString(16).padStart(64, '0')
  return { rid: `mpu1.${sourceId}.${digest}`, t: new Date().toISOString(), status: 200,
    agent: 'fixture-agent', provider, model: 'fixture-model', cost: 0, in: 10, out: 5 }
}

function countReports() {
  return database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM usage_reports').get()?.count
}

test('pairs once atomically and serves scoped configuration from a reopened database', async () => {
  const { source, pairingCode } = await createSource()
  expect(source).toMatchObject({ ...fixtureDraft, revision: 1, paired: false, lastSeenAt: null, lastReportAt: null })
  expect(Date.parse(source.pairingExpiresAt) - Date.now()).toBeGreaterThan(14 * 60_000)
  expect(pairingCode).toMatch(/^[0-9a-f]{64}$/)
  expect((await admin()).headers.get('cache-control')).toBe('no-store')
  expect(await (await admin()).text()).not.toContain(pairingCode)
  expect((await accessNode(configPath, pairingCode)).status).toBe(401)
  expect((await accessNode(sourcePath, pairingCode, fixtureDraft)).status).toBe(404)
  expect((await pair(pairingCode, pairingCode)).status).toBe(409)

  const keys = [newKey(), newKey()]
  const outcomes = await Promise.all(keys.map(key => pair(pairingCode, key)))
  expect(outcomes.map(response => response.status).sort()).toEqual([204, 401])
  const approvedKey = keys[outcomes.findIndex(response => response.status === 204)]
  expect((await pair(pairingCode, newKey())).status).toBe(401)
  await server.stop(true)
  database.close(true)
  restart()

  const config = await accessNode(configPath, approvedKey)
  expect(config.headers.get('cache-control')).toBe('no-store')
  expect(await config.json()).toEqual({ sourceInstanceId: source.id, enabled: true, pollIntervalSec: 60,
    sourceCallerKeyId: fixtureDraft.sourceCallerKeyId, sourceProviderId: fixtureDraft.sourceProviderId })
  const sourcesText = await (await admin()).text()
  expect(sourcesText).not.toContain(pairingCode)
  expect(sourcesText).not.toContain(approvedKey)
  expect(JSON.parse(sourcesText)).toMatchObject({ sources: [{ id: source.id, paired: true, revision: 2,
    pairingExpiresAt: null, lastSeenAt: expect.any(String), lastReportAt: null }] })
  const row = database.query<{ pairing_digest: string | null; credential_digest: string }, [string]>(
    'SELECT pairing_digest, credential_digest FROM managed_sources WHERE id = ?',
  ).get(source.id)
  expect(row).toEqual({ pairing_digest: null, credential_digest: createHash('sha256').update(approvedKey).digest('hex') })
})

test('renews an expired code and rejects stale or out-of-scope management edits', async () => {
  for (const draft of [
    { ...fixtureDraft, name: ' '.repeat(8) }, { ...fixtureDraft, pollIntervalSec: 901 },
    { ...fixtureDraft, sourceCallerKeyId: 'none' }, { ...fixtureDraft, sourceProviderId: 'not a provider ID' },
    { ...fixtureDraft, credentialDigest: 'd'.repeat(64) },
  ]) expect((await admin(sourcePath, draft)).status).toBe(400)
  const invalidType = new Request(new URL(sourcePath, server.url), { method: 'POST', body: 'fixture' })
  expect((await manage(invalidType)).status).toBe(415)
  expect((await manage(new Request(new URL(sourcePath, server.url), jsonPost(' '.repeat(4096))))).status).toBe(413)

  const { source, pairingCode } = await createSource({ enabled: false })
  const key = newKey()
  database.query('UPDATE managed_sources SET pairing_expires_at = ? WHERE id = ?').run(Date.now() - 1, source.id)
  expect((await pair(pairingCode, key)).status).toBe(401)
  const renewal = await admin(renewPath, { id: source.id, revision: source.revision })
  expect(renewal.status).toBe(200)
  const renewed = await renewal.json()
  expect(renewed.source).toMatchObject({ id: source.id, revision: 2, paired: false })
  expect(renewed.pairingCode).not.toBe(pairingCode)
  expect((await pair(pairingCode, key)).status).toBe(401)
  expect((await pair(renewed.pairingCode, key)).status).toBe(204)
  const conflict = await admin(settingsPath, { id: source.id, revision: 2, enabled: true, pollIntervalSec: 10 })
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({ error: { code: 'source_conflict' } })
  const alreadyPaired = await admin(renewPath, { id: source.id, revision: 3 })
  expect(alreadyPaired.status).toBe(409)
  expect(await alreadyPaired.json()).toEqual({ error: { code: 'source_already_paired' } })
  const changedScope = await admin(settingsPath, { id: source.id, revision: 3, enabled: true, pollIntervalSec: 10,
    sourceProviderId: 'different-provider' })
  expect(changedScope.status).toBe(400)
  expect((await admin(settingsPath, { id: randomUUID(), revision: 3, enabled: true, pollIntervalSec: 10 })).status).toBe(404)
})

test('only the enabled source can submit its assigned provider and receipts remain stable after pause and resume', async () => {
  const first = await createSource()
  const second = await createSource({ name: '合成另一来源' })
  const firstKey = newKey()
  const secondKey = newKey()
  expect((await pair(first.pairingCode, firstKey)).status).toBe(204)
  expect((await pair(second.pairingCode, secondKey)).status).toBe(204)
  const firstRow = report(first.source.id, 1)
  const extra = report(first.source.id, 2)
  const secondRow = report(second.source.id, 1)
  const mismatchedSource = await accessNode(reportsPath, firstKey, [firstRow, secondRow])
  expect(mismatchedSource.status).toBe(403)
  expect(await mismatchedSource.json()).toEqual({ error: { code: 'source_mismatch' } })
  const mismatchedProvider = await accessNode(reportsPath, firstKey, [firstRow, { ...extra, provider: 'wrong-provider' }])
  expect(mismatchedProvider.status).toBe(403)
  expect(await mismatchedProvider.json()).toEqual({ error: { code: 'provider_mismatch' } })
  expect(countReports()).toBe(0)

  const accepted = await accessNode(reportsPath, firstKey, [firstRow])
  expect(await accepted.json()).toEqual({ accepted: 1, skipped: 0, records: [{ rid: firstRow.rid, index: 0, status: 'accepted' }] })
  const savedAt = (await (await admin()).json()).sources.find((row: { id: string }) => row.id === first.source.id).lastReportAt
  expect(savedAt).toBeString()
  expect((await admin(settingsPath, { id: first.source.id, revision: 2, enabled: false, pollIntervalSec: 10 })).status).toBe(200)
  const disabled = await accessNode(reportsPath, firstKey, [extra])
  expect(disabled.status).toBe(403)
  expect(await disabled.json()).toEqual({ error: { code: 'source_paused' } })
  expect(await (await accessNode(configPath, firstKey)).json()).toMatchObject({ enabled: false, pollIntervalSec: 10 })
  expect((await accessNode(reportsPath, secondKey, [secondRow])).status).toBe(200)
  expect(countReports()).toBe(2)
  expect((await admin(settingsPath, { id: first.source.id, revision: 3, enabled: true, pollIntervalSec: 11 })).status).toBe(200)
  await Bun.sleep(15)
  const replay = await accessNode(reportsPath, firstKey, [firstRow])
  expect(await replay.json()).toEqual({ accepted: 0, skipped: 1, records: [{ rid: firstRow.rid, index: 0, status: 'skipped' }] })
  expect((await (await admin()).json()).sources.find((row: { id: string }) => row.id === first.source.id).lastReportAt).toBe(savedAt)
  expect((await accessNode(reportsPath, firstKey, [extra])).status).toBe(200)
  expect(countReports()).toBe(3)

  const native = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 503 }) })
  try {
    const dashboard = createDashboard(database, native.url, 1_000)
    const response = await dashboard(new URL('/api/usage?period=7d&scope=reported', native.url))
    expect(await response.json()).toMatchObject({ sources: expect.arrayContaining([
      { id: first.source.id, name: fixtureDraft.name, totals: expect.objectContaining({ attempts: 2 }) },
      { id: second.source.id, name: '合成另一来源', totals: expect.objectContaining({ attempts: 1 }) },
    ]) })
  } finally {
    await native.stop(true)
  }
})

test('a failed last-admission update rolls back managed rows and the next attempt can commit', async () => {
  const { source, pairingCode } = await createSource()
  const key = newKey()
  expect((await pair(pairingCode, key)).status).toBe(204)
  const row = report(source.id, 1)
  database.exec(`CREATE TRIGGER interrupt_managed_report BEFORE UPDATE OF last_report_at ON managed_sources
    BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`)
  expect((await accessNode(reportsPath, key, [row])).status).toBe(503)
  expect(countReports()).toBe(0)
  expect((await (await admin()).json()).sources[0].lastReportAt).toBeNull()
  database.exec('DROP TRIGGER interrupt_managed_report')
  expect(await (await accessNode(reportsPath, key, [row])).json()).toMatchObject({ accepted: 1, skipped: 0 })
  expect(countReports()).toBe(1)
})

test('checks the source setting again if it changed while the request body was in flight', async () => {
  const { source, pairingCode } = await createSource()
  const key = newKey()
  expect((await pair(pairingCode, key)).status).toBe(204)
  await server.stop(true)
  const sources = createSourceRegistry(database)
  const initialAuthorization = Promise.withResolvers<void>()
  server = serveIngest(database, undefined, 0, '127.0.0.1', { ...sources, reporter(digest) {
    const entry = sources.reporter(digest)
    if (digest === credentialDigest(key) && entry?.enabled === 1) initialAuthorization.resolve()
    return entry
  } })

  let input: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    input = controller
    controller.enqueue(new Uint8Array(32_768).fill(32))
  } })
  const request = fetch(new URL(reportsPath, server.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body,
    signal: AbortSignal.timeout(3_000),
  })
  const fixtureBody = new TextEncoder().encode(JSON.stringify([report(source.id, 1)]))
  try {
    const started = await Promise.race([initialAuthorization.promise.then(() => true), Bun.sleep(1_500).then(() => false)])
    expect(started).toBe(true)
    const pause = await admin(settingsPath, { id: source.id, revision: 2, enabled: false, pollIntervalSec: 5 })
    expect(pause.status).toBe(200)
  } finally {
    input?.enqueue(fixtureBody)
    input?.close()
    await request.catch(() => {})
  }
  const response = await request
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: { code: 'source_paused' } })
  expect(countReports()).toBe(0)
})

test('migrates an existing version-one ledger and deduplicates its existing static source records', async () => {
  await server.stop(true)
  database.close(true)
  dbPath = join(directory, 'old-usage.sqlite')
  const legacy = new Database(dbPath, { create: true, strict: true })
  const id = randomUUID()
  const row = report(id, 1)
  try {
    legacy.exec(`
      CREATE TABLE usage_reports (rid TEXT PRIMARY KEY NOT NULL, source_instance_id TEXT NOT NULL,
        called_at_ms INTEGER NOT NULL, row_json TEXT NOT NULL) STRICT;
      CREATE INDEX usage_reports_called_at ON usage_reports (called_at_ms, rid);
      CREATE INDEX usage_reports_source_called_at ON usage_reports (source_instance_id, called_at_ms, rid);
      PRAGMA user_version = 1;
    `)
    legacy.query('INSERT INTO usage_reports VALUES (?, ?, ?, ?)').run(row.rid, id, Date.parse(row.t), JSON.stringify(row))
  } finally {
    legacy.close(true)
  }
  const key = newKey()
  const managedLegacyKey = newKey()
  const keyFile = join(directory, 'legacy-keys.json')
  await writeFile(keyFile, JSON.stringify([{ sourceInstanceId: id, key }]), { mode: 0o600 })
  restart(keyFile)
  expect(database.query('PRAGMA user_version').get()).toEqual({ user_version: 2 })
  expect((await (await admin()).json()).sources).toEqual([])
  expect(await (await accessNode(reportsPath, key, [row])).json()).toMatchObject({ accepted: 0, skipped: 1 })
  expect(countReports()).toBe(1)

  const { source } = await createSource()
  await writeFile(keyFile, JSON.stringify([{ sourceInstanceId: source.id, key: managedLegacyKey }]), { mode: 0o600 })
  expect((await accessNode(reportsPath, managedLegacyKey, [report(source.id, 1)])).status).toBe(401)
  expect(countReports()).toBe(1)
})
