import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { tryAcquireSyncLock } from '../../src/state/lock.ts'
import { openSyncState, saveSyncProgress, type SyncBinding } from '../../src/state/store.ts'

const directoryPrefix = 'mpu-state-test-'
const binding: SyncBinding = {
  sourceGatewayUrl: 'http://127.0.0.1:3425/',
  sourceCallerKeyId: 'fixture-test-key',
  centralGatewayUrl: 'https://center.example/',
  initialMode: 'now',
}

let scratchRoot: string
let directory: string

beforeEach(async () => {
  scratchRoot = await realpath(tmpdir())
  directory = await mkdtemp(join(scratchRoot, directoryPrefix))
})

afterEach(async () => {
  const target = await realpath(directory)
  if (dirname(target) !== scratchRoot || !basename(target).startsWith(directoryPrefix)) {
    throw new Error('unexpected state test directory')
  }
  await rm(target, { recursive: true })
})

test('initializes identity before use and reloads a confirmed cursor', async () => {
  const state = await openSyncState(directory, binding)
  expect(state.cursor).toBeNull()
  expect(state.lastConfirmedAt).toBeNull()
  expect(state.sourceInstanceId).toMatch(/^[0-9a-f-]{36}$/)
  expect(JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))).toEqual({
    version: 1,
    sourceInstanceId: state.sourceInstanceId,
  })

  const confirmed = await saveSyncProgress(directory, state, 'opaque+cursor/=')
  expect(confirmed.cursor).toBe('opaque+cursor/=')
  expect(confirmed.lastConfirmedAt).toMatch(/Z$/)
  expect(state.cursor).toBeNull()
  expect(await openSyncState(directory, binding)).toEqual(confirmed)
})

test('restores a missing identity from a binding-matched state using the same UUID', async () => {
  const state = await openSyncState(directory, binding)
  const confirmed = await saveSyncProgress(directory, state, 'confirmed-cursor')
  const identityPath = join(directory, 'identity.json')
  const identity = await readFile(identityPath, 'utf8')
  await unlink(identityPath)
  expect(await openSyncState(directory, binding)).toEqual(confirmed)
  expect(await readFile(identityPath, 'utf8')).toBe(identity)
})

test('stops with an existing identity but missing state or a different UUID', async () => {
  await openSyncState(directory, binding)
  const statePath = join(directory, 'state.json')
  const savedState = await readFile(statePath, 'utf8')
  await unlink(statePath)
  await expect(openSyncState(directory, binding)).rejects.toMatchObject({ code: 'identity_mismatch' })
  expect(await readdir(directory)).toEqual(['identity.json'])

  await writeFile(statePath, savedState)
  const identityPath = join(directory, 'identity.json')
  const otherIdentity = '{"version":1,"sourceInstanceId":"61bf719b-d7e1-4a95-a75b-4204e861735b"}'
  await writeFile(identityPath, otherIdentity)
  await expect(openSyncState(directory, binding)).rejects.toMatchObject({ code: 'identity_mismatch' })
  expect(await readFile(identityPath, 'utf8')).toBe(otherIdentity)
  expect(await readFile(statePath, 'utf8')).toBe(savedState)
})

test('preserves progress when any binding changes', async () => {
  const state = await openSyncState(directory, binding)
  const confirmed = await saveSyncProgress(directory, state, 'confirmed-cursor')
  const alternateBindings: SyncBinding[] = [
    { ...binding, sourceGatewayUrl: 'http://127.0.0.1:3426/' },
    { ...binding, sourceCallerKeyId: 'other-test-key' },
    { ...binding, centralGatewayUrl: 'https://other.example/' },
    { ...binding, initialMode: 'start' },
  ]
  for (const alternate of alternateBindings) {
    await expect(openSyncState(directory, alternate)).rejects.toMatchObject({ code: 'binding_mismatch' })
  }
  expect(await openSyncState(directory, binding)).toEqual(confirmed)
})

test('preserves damaged data and unknown versions for recovery', async () => {
  const state = await openSyncState(directory, binding)
  await expect(saveSyncProgress(directory, state, ' opaque ')).rejects.toMatchObject({ code: 'state_invalid' })
  const damagedCases = [
    { name: 'state.json', raw: '{', code: 'state_invalid' },
    { name: 'state.json', raw: JSON.stringify({ ...state, version: 3 }), code: 'state_version_unsupported' },
    {
      name: 'state.json',
      raw: JSON.stringify({ ...state, cursor: 'start', lastConfirmedAt: '2026-11-25T01:02:03.000Z' }),
      code: 'state_invalid',
    },
    {
      name: 'state.json',
      raw: JSON.stringify({ ...state, cursor: ' opaque ', lastConfirmedAt: '2026-11-25T01:02:03.000Z' }),
      code: 'state_invalid',
    },
    { name: 'identity.json', raw: '{}', code: 'state_invalid' },
    { name: 'identity.json', raw: '{"version":2}', code: 'state_version_unsupported' },
  ]
  for (const fixture of damagedCases) {
    const path = join(directory, fixture.name)
    const original = await readFile(path, 'utf8')
    await writeFile(path, fixture.raw)
    await expect(openSyncState(directory, binding)).rejects.toMatchObject({ code: fixture.code })
    expect(await readFile(path, 'utf8')).toBe(fixture.raw)
    await writeFile(path, original)
  }
})

test.each(['sync', 'rename'] as const)('keeps the prior state when %s fails', async (failurePoint) => {
  const state = await openSyncState(directory, binding)
  const confirmed = await saveSyncProgress(directory, state, 'confirmed-cursor')
  const statePath = join(directory, 'state.json')
  const stored = await readFile(statePath, 'utf8')
  const attempted: string[] = []
  const replacements: { directory: string; target: string }[] = []

  await expect(saveSyncProgress(directory, confirmed, 'later-cursor', {
    async sync(file) {
      attempted.push('sync')
      if (failurePoint === 'sync') throw new Error('injected sync failure')
      await file.sync()
    },
    async rename(temporary, target) {
      attempted.push('rename')
      replacements.push({ directory: dirname(temporary), target })
      throw new Error('injected rename failure')
    },
  })).rejects.toMatchObject({ code: 'state_write_failed' })

  expect(attempted).toEqual(failurePoint === 'sync' ? ['sync'] : ['sync', 'rename'])
  expect(replacements).toEqual(failurePoint === 'rename' ? [{ directory, target: statePath }] : [])
  expect(await readFile(statePath, 'utf8')).toBe(stored)
  expect((await readdir(directory)).sort()).toEqual(['identity.json', 'state.json'])
  expect(await openSyncState(directory, binding)).toEqual(confirmed)
})

test.skipIf(process.platform !== 'win32')('retries sharing failures with the same flushed replacement', async () => {
  const state = await openSyncState(directory, binding)
  const confirmed = await saveSyncProgress(directory, state, 'confirmed-cursor')
  const statePath = join(directory, 'state.json')
  const stored = await readFile(statePath, 'utf8')
  const sharingErrors = ['EPERM', 'EBUSY', 'EACCES']
  const replacements: string[] = []
  let flushes = 0

  const updated = await saveSyncProgress(directory, confirmed, 'later-cursor', {
    async sync(file) {
      flushes += 1
      await file.sync()
    },
    async rename(temporary, target) {
      expect(target).toBe(statePath)
      expect(await readFile(target, 'utf8')).toBe(stored)
      const code = sharingErrors[replacements.length]
      replacements.push(temporary)
      if (code !== undefined) throw Object.assign(new Error('injected sharing failure'), { code })
      await rename(temporary, target)
    },
  })

  expect(flushes).toBe(1)
  expect(replacements).toHaveLength(sharingErrors.length + 1)
  expect(new Set(replacements).size).toBe(1)
  expect((await readdir(directory)).sort()).toEqual(['identity.json', 'state.json'])
  expect(updated.cursor).toBe('later-cursor')
  expect(await openSyncState(directory, binding)).toEqual(updated)
})

test('releases the native lock to another connection', () => {
  const owner = tryAcquireSyncLock(directory)
  try {
    expect(owner).toBeDefined()
    const contender = tryAcquireSyncLock(directory)
    try {
      expect(contender).toBeUndefined()
    } finally {
      contender?.release()
    }
  } finally {
    owner?.release()
  }
  const replacement = tryAcquireSyncLock(directory)
  try {
    expect(replacement).toBeDefined()
  } finally {
    replacement?.release()
  }
})

test('fails closed if the lock path is not a regular file', async () => {
  await mkdir(join(directory, 'sync.lock.sqlite'))
  expect(() => tryAcquireSyncLock(directory)).toThrow('lock_unavailable')
})

function spawnLockProcess(hold: boolean) {
  const url = new URL('../../src/state/lock.ts', import.meta.url).href
  const program = `
    import { tryAcquireSyncLock } from ${JSON.stringify(url)}
    const lock = tryAcquireSyncLock(${JSON.stringify(directory)})
    console.log(lock ? 'owned' : 'busy')
    if (lock && ${hold}) await Bun.sleep(30_000)
    lock?.release()
  `
  return Bun.spawn([process.execPath, '-e', program], { stdout: 'pipe' })
}

test('grants another process ownership after the prior owner is terminated', async () => {
  const owner = spawnLockProcess(true)
  const reader = owner.stdout.getReader()
  try {
    const firstOutput = (await reader.read()).value
    expect(new TextDecoder().decode(firstOutput).trim()).toBe('owned')

    const contender = spawnLockProcess(false)
    expect((await new Response(contender.stdout).text()).trim()).toBe('busy')
    expect(await contender.exited).toBe(0)
  } finally {
    reader.releaseLock()
    owner.kill('SIGKILL')
    await owner.exited
  }

  const replacement = spawnLockProcess(false)
  expect((await new Response(replacement.stdout).text()).trim()).toBe('owned')
  expect(await replacement.exited).toBe(0)
})
