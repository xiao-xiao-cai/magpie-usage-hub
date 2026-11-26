import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { SyncOptions } from '../../src/options.ts'
import { readRecoveryRequest, type RecoveryRequest } from '../../src/recovery.ts'
import { openSyncState, readStoredSyncState, saveSyncProgress, type SyncBinding } from '../../src/state/store.ts'
import type { ReportRow } from '../../src/sync/mapping.ts'
import { readValidatedPage, sendUsagePage } from '../../src/sync/read-page.ts'
import { advanceRecoveryPage, prepareRecovery } from '../../src/sync/recovery.ts'

const directoryPrefix = 'mpu-recovery-test-'
const from = '2025-11-01T00:00:00.000Z'
const to = '2025-11-02T00:00:00.000Z'
const callerKey = 'fixture-source-key'
const dailyCursor = 'saved-daily-opaque-cursor'
const timeoutMs = 2_000

let scratchRoot: string
let directory: string
const stopListeners: Array<() => Promise<void>> = []

function listen(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch })
  stopListeners.push(() => server.stop(true))
  return server
}

beforeEach(async () => {
  scratchRoot = await realpath(tmpdir())
  directory = await mkdtemp(join(scratchRoot, directoryPrefix))
})

afterEach(async () => {
  await Promise.all(stopListeners.splice(0).map(stop => stop()))
  const target = await realpath(directory)
  if (dirname(target) !== scratchRoot || !basename(target).startsWith(directoryPrefix)) {
    throw new Error('unexpected recovery test directory')
  }
  await rm(target, { recursive: true })
})

function row(id: string, t = from) {
  return { id, t, callerKeyId: callerKey, origin: 'gateway', agent: 'fixture-agent',
    provider: 'fixture-provider', model: 'fixture-model', status: 200, in: 4, out: 2, priced: true, cost: 0 }
}

function feed(nextCursor: string, rows: unknown[] = [], hasMore = false) {
  return Response.json({ rows, deleted: [], next_cursor: nextCursor, has_more: hasMore })
}

function cursorError(code: string, status = 410) {
  return Response.json({ error: { code } }, { status })
}

function rangeRequest(binding: SyncBinding): RecoveryRequest {
  return { id: randomUUID(), kind: 'range', binding, from, to }
}

function ridFor(sourceInstanceId: string, rowId: string): string {
  return `mpu1.${sourceInstanceId}.${createHash('sha256').update(rowId).digest('hex')}`
}

async function fixture(
  read: (cursor: string, query: URLSearchParams) => Response,
  options: { loseReceiptForBatch?: number; sourceProviderId?: string } = {},
) {
  const cursors: string[] = []
  const sentBatches: ReportRow[][] = []
  const ledger = new Set<string>()
  const reportKey = options.sourceProviderId ? 'a'.repeat(64) : 'synthetic-reporting-key'
  const source = listen(request => {
    const url = new URL(request.url)
    expect(request.method).toBe('GET')
    expect(url.pathname).toBe('/v1/magpie/usage/requests')
    expect(url.searchParams.get('via')).toBe('through')
    expect(url.searchParams.get('callerKey')).toBe(callerKey)
    expect(url.searchParams.get('provider')).toBe(options.sourceProviderId ?? null)
    const cursor = url.searchParams.get('cursor') ?? ''
    cursors.push(cursor)
    return read(cursor, url.searchParams)
  })
  const center = listen(async request => {
    expect(request.method).toBe('POST')
    expect(new URL(request.url).pathname).toBe('/v1/magpie/usage/requests')
    expect(request.headers.get('authorization')).toBe(`Bearer ${reportKey}`)
    const batch: ReportRow[] = await request.json()
    sentBatches.push(batch)
    const records = batch.map(({ rid }, index) => {
      const status = ledger.has(rid) ? 'skipped' : 'accepted'
      ledger.add(rid)
      return { rid, index, status }
    })
    if (sentBatches.length === options.loseReceiptForBatch) return new Response(null, { status: 503 })
    const accepted = records.filter(record => record.status === 'accepted').length
    return Response.json({ records, accepted, skipped: records.length - accepted })
  })
  const centralKeyFile = join(directory, 'synthetic-key.txt')
  await writeFile(centralKeyFile, reportKey, 'utf8')
  const binding: SyncBinding = {
    sourceGatewayUrl: source.url.href,
    centralGatewayUrl: center.url.href,
    sourceCallerKeyId: callerKey,
    ...(options.sourceProviderId === undefined ? {} : { sourceProviderId: options.sourceProviderId }),
    initialMode: 'now',
  }
  const syncOptions: SyncOptions = {
    ...binding, sourceGatewayUrl: source.url, centralGatewayUrl: center.url,
    centralKeyFile, pollIntervalSec: 60, requestTimeoutSec: 30,
  }
  return { binding, syncOptions, cursors, ledger, sentBatches, reportKey }
}

test('uses the same dedicated Key, provider and rid for normal sync and recovery', async () => {
  const sourceProviderId = 'fixture-provider'
  const candidates = [
    row('matching'), { ...row('other-provider'), provider: 'fixture-other' },
    { ...row('other-caller'), callerKeyId: 'fixture-other-key' },
  ]
  let leak = false
  const { binding, syncOptions, ledger, sentBatches, cursors, reportKey } = await fixture((_, query) => {
    const scoped = candidates.filter(row => row.provider === query.get('provider') && row.callerKeyId === query.get('callerKey'))
    return feed('scoped-head', leak ? candidates : scoped)
  }, { sourceProviderId })
  const state = await openSyncState(directory, binding)
  const page = await readValidatedPage(syncOptions, dailyCursor, timeoutMs)
  await writeFile(syncOptions.centralKeyFile, 'legacy-native-key', 'utf8')
  await expect(sendUsagePage(syncOptions, page, state.sourceInstanceId, timeoutMs)).rejects.toMatchObject({
    stage: 'center', code: 'invalid_key_file',
  })
  expect(sentBatches).toHaveLength(0)
  await writeFile(syncOptions.centralKeyFile, reportKey, 'utf8')
  expect(await sendUsagePage(syncOptions, page, state.sourceInstanceId, timeoutMs)).toEqual({ accepted: 1, skipped: 0 })
  const confirmed = await saveSyncProgress(directory, state, page.nextCursor)
  const request = rangeRequest(binding)
  expect(readRecoveryRequest(request)).toEqual(request)
  const accepted = await prepareRecovery(directory, confirmed, request, syncOptions, timeoutMs)
  expect(await readStoredSyncState(directory)).toEqual(accepted)
  leak = true
  await expect(advanceRecoveryPage(directory, accepted, syncOptions, timeoutMs)).rejects.toMatchObject({
    code: 'unexpected_provider',
  })
  expect(await readStoredSyncState(directory)).toEqual(accepted)
  expect(sentBatches).toHaveLength(1)
  leak = false
  const recovered = await advanceRecoveryPage(directory, accepted, syncOptions, timeoutMs)
  expect(recovered).toMatchObject({ accepted: 0, skipped: 1, state: { cursor: 'scoped-head' } })
  expect([...ledger]).toEqual([ridFor(state.sourceInstanceId, 'matching')])
  expect(sentBatches[0]).toEqual(sentBatches[1])
  expect(cursors).toEqual([dailyCursor, 'start', 'start'])
})

test('migrates on acceptance and repairs a missing time range while preserving the daily checkpoint', async () => {
  const sample = await fixture(cursor => {
    if (cursor === 'start') {
      return feed('range-next', [
        row('at-cutoff', to),
        { ...row('before', '2025-10-31T23:59:59.999999999Z'), model: undefined },
        row('inclusive-start', '2025-11-01T08:00:00+08:00'),
        { ...row('remote-copy'), computer: 'fixture-remote' },
      ], true)
    }
    expect(cursor).toBe('range-next')
    return feed('range-head', [row('existing', '2025-11-01T23:59:59.999999999Z'), row('after', '2025-11-03T00:00:00Z')])
  })
  const { binding, syncOptions, ledger, sentBatches, cursors } = sample
  const previousState = await saveSyncProgress(directory, await openSyncState(directory, binding), dailyCursor)
  const identityPath = join(directory, 'identity.json')
  const identity = await readFile(identityPath, 'utf8')
  expect(previousState).toEqual({ version: 1, sourceInstanceId: previousState.sourceInstanceId,
    binding, cursor: dailyCursor, lastConfirmedAt: previousState.lastConfirmedAt })
  const existingRid = ridFor(previousState.sourceInstanceId, 'existing')
  ledger.add(existingRid)
  const request = rangeRequest(binding)

  const accepted = await prepareRecovery(directory, previousState, request, syncOptions, timeoutMs)
  expect(accepted).toMatchObject({ version: 2, cursor: dailyCursor, recovery: { active: { request, cursor: null } } })
  expect(await readFile(identityPath, 'utf8')).toBe(identity)
  const first = await advanceRecoveryPage(directory, accepted, syncOptions, timeoutMs)
  expect(first).toMatchObject({ accepted: 1, skipped: 0, hasMore: true,
    state: { cursor: dailyCursor, recovery: { active: { request, cursor: 'range-next', pages: 1 } } } })

  const reloaded = await openSyncState(directory, binding, { requireExisting: true })
  expect(await prepareRecovery(directory, reloaded, undefined, syncOptions, timeoutMs)).toBe(reloaded)
  const last = await advanceRecoveryPage(directory, reloaded, syncOptions, timeoutMs)
  expect(last).toMatchObject({ accepted: 0, skipped: 1, hasMore: false,
    state: { cursor: dailyCursor, lastConfirmedAt: previousState.lastConfirmedAt, recovery: {
      active: null, results: [{ request, status: 'complete', pages: 2, accepted: 1, skipped: 1 }],
    } } })
  const restored = await openSyncState(directory, binding, { requireExisting: true })
  expect(await prepareRecovery(directory, restored, request, syncOptions, timeoutMs)).toBe(restored)
  const newRid = ridFor(previousState.sourceInstanceId, 'inclusive-start')
  expect([...ledger]).toEqual([existingRid, newRid])
  expect(sentBatches.map(batch => batch.map(({ rid }) => rid))).toEqual([[newRid], [existingRid]])
  expect(sentBatches[0]?.[0]).toMatchObject({ t: '2025-11-01T08:00:00+08:00', in: 4, out: 2, status: 200, cost: 0 })
  expect(cursors).toEqual(['start', 'range-next'])
})

test('replays the same whole page after a later sub-batch receipt is lost', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => row(`synthetic-${index}`))
  const { binding, syncOptions, cursors, ledger, sentBatches } = await fixture(() => feed('range-head', rows), {
    loseReceiptForBatch: 2,
  })
  const previousState = await saveSyncProgress(directory, await openSyncState(directory, binding), dailyCursor)
  const request = rangeRequest(binding)
  const accepted = await prepareRecovery(directory, previousState, request, syncOptions, timeoutMs)
  const statePath = join(directory, 'state.json')
  const checkpoint = await readFile(statePath, 'utf8')
  await expect(advanceRecoveryPage(directory, accepted, syncOptions, timeoutMs)).rejects.toMatchObject({
    code: 'upstream_failure', stage: 'center',
  })
  expect(await readFile(statePath, 'utf8')).toBe(checkpoint)
  expect(ledger.size).toBe(rows.length)

  const resumed = await openSyncState(directory, binding)
  const last = await advanceRecoveryPage(directory, resumed, syncOptions, timeoutMs)
  expect(last).toMatchObject({ accepted: 0, skipped: rows.length, state: { cursor: dailyCursor, recovery: {
    active: null, results: [{ request, status: 'complete', pages: 1, accepted: 0, skipped: rows.length }],
  } } })
  expect(cursors).toEqual(['start', 'start'])
  expect(sentBatches.map(batch => batch.length)).toEqual([200, 1, 200, 1])
  expect(sentBatches.slice(2)).toEqual(sentBatches.slice(0, 2))
  expect(ledger.size).toBe(rows.length)
})

test.each(['cursor_reset', 'cursor_expired'])('replaces an unusable daily checkpoint on completion after %s', async code => {
  const { binding, syncOptions, cursors, ledger } = await fixture(cursor => {
    if (cursor === dailyCursor) return cursorError(code)
    if (cursor === 'start') {
      return feed('new-intermediate', [row('before', '2025-10-31T23:59:59.999Z'), row('first')], true)
    }
    expect(cursor).toBe('new-intermediate')
    return feed('new-opaque-head', [row('after-range-example', '2025-11-03T00:00:00Z')])
  })
  const previousState = await saveSyncProgress(directory, await openSyncState(directory, binding), dailyCursor)
  const request: RecoveryRequest = { id: randomUUID(), kind: 'cursor', binding, from }
  const accepted = await prepareRecovery(directory, previousState, request, syncOptions, timeoutMs)
  expect(accepted.cursor).toBe(dailyCursor)
  const first = await advanceRecoveryPage(directory, accepted, syncOptions, timeoutMs)
  expect(first.state.cursor).toBe(dailyCursor)

  const path = join(directory, 'state.json')
  const checkpoint = await readFile(path, 'utf8')
  await expect(advanceRecoveryPage(directory, first.state, syncOptions, timeoutMs, {
    async sync(file) { await file.sync() },
    async rename() { throw new Error('injected replacement failure') },
  })).rejects.toMatchObject({ code: 'state_write_failed' })
  expect(await readFile(path, 'utf8')).toBe(checkpoint)
  expect(ledger.size).toBe(2)

  const resumed = await openSyncState(directory, binding, { requireExisting: true })
  const last = await advanceRecoveryPage(directory, resumed, syncOptions, timeoutMs)
  expect(last).toMatchObject({ accepted: 0, skipped: 1, hasMore: false, state: { cursor: 'new-opaque-head',
    recovery: { active: null, results: [{ request, status: 'complete', pages: 2, accepted: 1, skipped: 1 }] },
  } })
  const result = last.state.recovery?.results.at(-1)
  expect(result?.status).toBe('complete')
  expect(result?.status === 'complete' ? result.lastConfirmedAt : null).toBe(last.state.lastConfirmedAt)
  expect(await readStoredSyncState(directory)).toEqual(last.state)
  expect(cursors).toEqual([dailyCursor, 'start', 'new-intermediate', 'new-intermediate'])
  expect([...ledger]).toEqual(['first', 'after-range-example'].map(id => ridFor(previousState.sourceInstanceId, id)))
})

test('keeps audited progress across repeated scan invalidation and explicit re-confirmation', async () => {
  const confirmedCallsAt = '2025-11-01T12:00:00.000Z'
  let generation = 1
  const { binding, syncOptions, sentBatches, cursors } = await fixture(cursor => {
    if (cursor === dailyCursor) return cursorError('cursor_reset')
    if (cursor === 'start') return feed(`scan-${generation}`, [row('confirmed-earlier', confirmedCallsAt)], true)
    expect(cursor).toBe(`scan-${generation}`)
    if (generation === 1) return cursorError('cursor_expired')
    if (generation === 2) return cursorError('cursor_reset')
    return feed('finished-head', [row('later', confirmedCallsAt)])
  })
  const previousState = await saveSyncProgress(directory, await openSyncState(directory, binding), dailyCursor)
  const firstRequest: RecoveryRequest = { id: randomUUID(), kind: 'cursor', binding, from }
  const secondRequest: RecoveryRequest = { ...firstRequest, id: randomUUID(), from: confirmedCallsAt }
  const thirdRequest: RecoveryRequest = { ...secondRequest, id: randomUUID() }
  let state = previousState

  for (const [request, reason, accepted, skipped] of [
    [firstRequest, 'recovery_scan_cursor_expired', 1, 0],
    [secondRequest, 'recovery_scan_cursor_reset', 0, 1],
  ] as const) {
    state = await prepareRecovery(directory, state, request, syncOptions, timeoutMs)
    const first = await advanceRecoveryPage(directory, state, syncOptions, timeoutMs)
    expect(first).toMatchObject({ status: 'confirmed', accepted, skipped, hasMore: true })
    const reloaded = await openSyncState(directory, binding, { requireExisting: true })
    const failed = await advanceRecoveryPage(directory, reloaded, syncOptions, timeoutMs)
    expect(failed).toMatchObject({ status: 'failed', reason, state: {
      cursor: dailyCursor, lastConfirmedAt: previousState.lastConfirmedAt, recovery: { active: null },
    } })
    state = await openSyncState(directory, binding, { requireExisting: true })
    const restoredFailure = state.recovery?.results.at(-1)
    expect(restoredFailure).toMatchObject({ request, status: 'failed', reason, pages: 1, accepted, skipped,
      lastConfirmedAt: reloaded.recovery?.active?.lastConfirmedAt })
    expect(restoredFailure?.status === 'failed' ? restoredFailure.failedAt : '').toMatch(/Z$/)
    expect(await prepareRecovery(directory, state, request, syncOptions, timeoutMs)).toBe(state)
    generation += 1
  }

  state = await prepareRecovery(directory, state, thirdRequest, syncOptions, timeoutMs)
  const first = await advanceRecoveryPage(directory, state, syncOptions, timeoutMs)
  const last = await advanceRecoveryPage(directory, first.state, syncOptions, timeoutMs)
  expect(last).toMatchObject({ status: 'confirmed', accepted: 1, skipped: 0, state: { cursor: 'finished-head', recovery: {
    active: null, results: [
      { request: firstRequest, status: 'failed', pages: 1, accepted: 1, skipped: 0 },
      { request: secondRequest, status: 'failed', pages: 1, accepted: 0, skipped: 1 },
      { request: thirdRequest, status: 'complete', pages: 2, accepted: 1, skipped: 1 },
    ],
  } } })
  expect(sentBatches.slice(0, 3).map(batch => batch[0]?.rid)).toEqual(Array(3).fill(
    ridFor(previousState.sourceInstanceId, 'confirmed-earlier'),
  ))
  expect(cursors).toEqual([dailyCursor, 'start', 'scan-1', dailyCursor, 'start', 'scan-2', dailyCursor, 'start', 'scan-3'])
})

test('durably rejects a still-valid cursor, a wrong binding and a new request during active recovery', async () => {
  const { binding, syncOptions, cursors } = await fixture(() => feed(dailyCursor))
  const previousState = await saveSyncProgress(directory, await openSyncState(directory, binding), dailyCursor)
  const valid: RecoveryRequest = { id: randomUUID(), kind: 'cursor', binding, from }
  const wrong = rangeRequest({ ...binding, centralGatewayUrl: 'https://other.example/' })
  const request = rangeRequest(binding)
  const busy = rangeRequest(binding)
  const rejected = await prepareRecovery(directory, previousState, valid, syncOptions, timeoutMs)
  expect(rejected).toMatchObject({ version: 1, cursor: dailyCursor, recovery: { active: null, results: [
    { request: valid, status: 'rejected', reason: 'recovery_cursor_valid' },
  ] } })
  const reloaded = await openSyncState(directory, binding)
  expect(await prepareRecovery(directory, reloaded, valid, syncOptions, timeoutMs)).toBe(reloaded)

  const wrongBinding = await prepareRecovery(directory, reloaded, wrong, syncOptions, timeoutMs)
  const active = await prepareRecovery(directory, wrongBinding, request, syncOptions, timeoutMs)
  const busyResult = await prepareRecovery(directory, active, busy, syncOptions, timeoutMs)
  expect(busyResult).toMatchObject({ version: 2, recovery: { active: { request }, results: [
    { request: valid, status: 'rejected', reason: 'recovery_cursor_valid' },
    { request: wrong, status: 'rejected', reason: 'recovery_binding_mismatch' },
    { request: busy, status: 'rejected', reason: 'recovery_busy' },
  ] } })
  expect(await readStoredSyncState(directory)).toEqual(busyResult)
  expect(cursors).toEqual([dailyCursor])
})

test('requires an existing source identity and checks status without repairing its files', async () => {
  const { binding, syncOptions } = await fixture(() => feed(dailyCursor))
  await expect(openSyncState(directory, binding, { requireExisting: true })).rejects.toMatchObject({
    code: 'recovery_no_checkpoint',
  })
  expect(await readdir(directory)).toEqual(['synthetic-key.txt'])
  const opened = await openSyncState(directory, binding)
  const request = rangeRequest(binding)
  const rejected = await prepareRecovery(directory, opened, request, syncOptions, timeoutMs)
  expect(rejected).toMatchObject({ version: 1, cursor: null, recovery: { results: [
    { request, status: 'rejected', reason: 'recovery_no_checkpoint' },
  ] } })
  await unlink(join(directory, 'identity.json'))
  expect(await readStoredSyncState(directory)).toEqual(rejected)
  expect(await readdir(directory)).not.toContain('identity.json')
  expect(await openSyncState(directory, binding, { requireExisting: true })).toEqual(rejected)
  expect(await readdir(directory)).toContain('identity.json')
})

test('leaves the checkpoint untouched after transient cursor probe failures and rejects an incompatible cursor', async () => {
  let available = false
  const { binding, syncOptions, cursors } = await fixture(() => available
    ? cursorError('cursor_filter_changed', 400) : new Response(null, { status: 503 }))
  const previousState = await saveSyncProgress(directory, await openSyncState(directory, binding), dailyCursor)
  const request: RecoveryRequest = { id: randomUUID(), kind: 'cursor', binding, from }
  await expect(prepareRecovery(directory, previousState, request, syncOptions, timeoutMs)).rejects.toMatchObject({
    code: 'upstream_failure', stage: 'source',
  })
  expect(await readStoredSyncState(directory)).toEqual(previousState)
  available = true
  const rejected = await prepareRecovery(directory, previousState, request, syncOptions, timeoutMs)
  expect(rejected).toMatchObject({ version: 1, recovery: { active: null, results: [
    { request, status: 'rejected', reason: 'recovery_cursor_incompatible' },
  ] } })
  expect(cursors).toEqual([dailyCursor, dailyCursor])
})

test('validates the Options recovery scope and protects a damaged active checkpoint', async () => {
  const { binding, syncOptions } = await fixture(() => feed(dailyCursor))
  const request = rangeRequest(binding)
  expect(readRecoveryRequest(request)).toEqual(request)
  expect(readRecoveryRequest(undefined)).toBeUndefined()
  for (const damaged of [
    { ...request, id: 'same-id' },
    { ...request, from: to },
    { ...request, to: '9999-01-01T00:00:00.000Z' },
    { ...request, to: '2025-11-02T08:00:00+08:00' },
    { ...request, kind: 'cursor' },
    { ...request, binding: { ...binding, centralGatewayUrl: 'https://fixture-user@center.example/' } },
    { ...request, binding: { ...binding, sourceProviderId: '' } },
  ]) {
    expect(() => readRecoveryRequest(damaged)).toThrow('invalid_recovery_request')
  }

  const previousState = await saveSyncProgress(directory, await openSyncState(directory, binding), dailyCursor)
  const active = await prepareRecovery(directory, previousState, request, syncOptions, timeoutMs)
  const invalidState = JSON.stringify({ ...active, recovery: { results: [], active: {
    ...active.recovery?.active, pages: 1, cursor: 'start', lastConfirmedAt: from,
  } } })
  const path = join(directory, 'state.json')
  await writeFile(path, invalidState, 'utf8')
  await expect(openSyncState(directory, binding)).rejects.toMatchObject({ code: 'state_invalid' })
  expect(await readFile(path, 'utf8')).toBe(invalidState)
})
