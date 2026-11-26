import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { link, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { prepareNativeUsageCleanup } from '../../scripts/prepare-native-usage-cleanup.ts'

const directoryPrefix = 'mpu-cleanup-test-'
const source = '550e8400-e29b-41d4-a716-446655440000'
const target = `mpu1.${source}.${'a'.repeat(64)}`
const otherTarget = `mpu1.${source}.${'b'.repeat(64)}`
const usageName = 'usage.snapshot.jsonl'
const feedName = 'usage-feed.snapshot.jsonl'
const approvalName = 'approved-rids.json'
const candidateName = 'usage.cleaned.candidate.jsonl'
const feed = '{"epoch":"abc123def4560123","s":6,"floor":2}\n'
  + '{"s":6,"i":"u_1234567890abcdef1234","v":"aabcb2001"}\n'
  + '{"s":4,"i":"u_2234567890abcdef1234","v":"ca","k":"fixture-caller"}\n'
  + '{"s":7,"i":"u_1234567890abcdef1234","g":true,"t":1772452527}\n'
const row = { t: '2026-11-26T11:30:00.125+08:00', agent: 'fixture', provider: 'fixture', model: '合成模型' }
const targetLine = JSON.stringify({ ...row, source: 'reported', rid: target }) + '\n'
const anotherTargetLine = JSON.stringify({ ...row, source: 'reported', rid: otherTarget }) + '\n'
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

let scratchRoot: string
let directory: string

beforeEach(async () => {
  scratchRoot = await realpath(tmpdir())
  directory = await mkdtemp(join(scratchRoot, directoryPrefix))
  await writeFile(join(directory, usageName), targetLine, { mode: 0o600 })
  await writeFile(join(directory, feedName), feed, { mode: 0o600 })
  await writeFile(join(directory, approvalName), JSON.stringify([target]), { mode: 0o600 })
})

afterEach(async () => {
  const resolved = await realpath(directory)
  if (dirname(resolved) !== scratchRoot || !basename(resolved).startsWith(directoryPrefix)) {
    throw new Error('unexpected cleanup test directory')
  }
  await rm(resolved, { recursive: true })
})

async function expectOnlyInputs() {
  expect((await readdir(directory)).sort()).toEqual([approvalName, feedName, usageName].sort())
}

test('reports counts and exact byte digests, then exclusively writes the verified retained rows', async () => {
  const local = ' ' + JSON.stringify({ ...row, rid: `vendor-${target}`, extra: { source: 'reported', rid: target } }) + ' \r\n'
  const shared = JSON.stringify({ ...row, computer: 'fixture-computer', rid: 'other-vendor-id' }) + '\n'
  const unapproved = JSON.stringify({ ...row, source: 'reported', rid: 'other-client-report' }) + '\n'
  const large = JSON.stringify({ ...row, fixturePadding: '字'.repeat(100_000) }) + '\r\n'
  const records = local + targetLine + shared + unapproved + anotherTargetLine + large
  const retained = local + shared + unapproved + large
  const approval = JSON.stringify([target, otherTarget]) + '\n'
  await writeFile(join(directory, usageName), records)
  await writeFile(join(directory, approvalName), approval)

  const verified = await prepareNativeUsageCleanup(directory)
  expect(verified).toEqual({
    original: { rows: 6, sha256: sha256(records) },
    retained: { rows: 4, sha256: sha256(retained) },
    removedRows: 2,
    feed: { lines: 4, sha256: sha256(feed) },
  })
  await expectOnlyInputs()
  expect(await prepareNativeUsageCleanup(directory, true)).toEqual(verified)
  expect(await readFile(join(directory, candidateName))).toEqual(Buffer.from(retained))
  expect(await readFile(join(directory, usageName), 'utf8')).toBe(records)
  expect(await readFile(join(directory, feedName), 'utf8')).toBe(feed)
  expect(await readFile(join(directory, approvalName), 'utf8')).toBe(approval)
  await expect(prepareNativeUsageCleanup(directory, true)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(join(directory, candidateName))).toEqual(Buffer.from(retained))
  expect((await readdir(directory)).sort()).toEqual([approvalName, feedName, usageName, candidateName].sort())
})

test('can remove the complete approved report set from a snapshot that has no other rows', async () => {
  const result = await prepareNativeUsageCleanup(directory, true)
  expect(result.retained).toEqual({ rows: 0, sha256: sha256('') })
  expect(await readFile(join(directory, candidateName), 'utf8')).toBe('')
  expect(await readFile(join(directory, usageName), 'utf8')).toBe(targetLine)
})

test('refuses unapproved aliases, missing and duplicate matches, and a shared reported row', async () => {
  const localWithTarget = JSON.stringify({ ...row, rid: target }) + '\n'
  const sharedWithTarget = JSON.stringify({ ...row, source: 'reported', rid: target, computer: 'fixture-computer' }) + '\n'
  for (const [usage, reason] of [
    [anotherTargetLine, 'missing_approved_rid_match'],
    [targetLine + targetLine, 'duplicate_approved_rid_match'],
    [targetLine + localWithTarget, 'approved_rid_not_local_report'],
    [sharedWithTarget, 'approved_rid_not_local_report'],
    [targetLine.replace('"source"', '"Source"'), 'invalid_usage_snapshot'],
    [targetLine.replace('"source"', '"source":"anything","s\\u006furce"'), 'invalid_usage_snapshot'],
    [targetLine.replace('"rid"', '"rid":"other","RID"'), 'invalid_usage_snapshot'],
  ] as const) {
    await writeFile(join(directory, usageName), usage)
    await expect(prepareNativeUsageCleanup(directory, true)).rejects.toThrow(reason)
    await expectOnlyInputs()
    expect(await readFile(join(directory, usageName), 'utf8')).toBe(usage)
    expect(await readFile(join(directory, feedName), 'utf8')).toBe(feed)
  }
})

test('refuses malformed approvals without printing values or creating a candidate', async () => {
  for (const approval of [[target, target], [`${target}\n`], ['mpu1.*'], [], { rids: [target] }]) {
    await writeFile(join(directory, approvalName), JSON.stringify(approval))
    await expect(prepareNativeUsageCleanup(directory, true)).rejects.toThrow('invalid_approved_rids')
    await expectOnlyInputs()
    expect(await readFile(join(directory, approvalName), 'utf8')).toBe(JSON.stringify(approval))
  }
})

test('refuses a BOM, invalid UTF-8, a blank line or an unterminated ledger line', async () => {
  for (const usage of [Buffer.from('\uFEFF' + targetLine), Buffer.from([255, 10]), Buffer.from(targetLine + '\n'),
    Buffer.from(targetLine.slice(0, -1)), Buffer.from(targetLine + '{"t":\n')]) {
    await writeFile(join(directory, usageName), usage)
    await expect(prepareNativeUsageCleanup(directory, true)).rejects.toThrow('invalid_usage_snapshot')
    await expectOnlyInputs()
    expect(await readFile(join(directory, usageName))).toEqual(usage)
  }
})

test('refuses a missing header, malformed change or torn end of the cursor journal', async () => {
  for (const brokenFeed of ['', '\uFEFF' + feed, feed.split('\n').slice(1).join('\n'),
    feed.replace('"g":true,"t":1772452527', '"g":true'), feed.slice(0, -1)]) {
    await writeFile(join(directory, feedName), brokenFeed)
    await expect(prepareNativeUsageCleanup(directory, true)).rejects.toThrow('invalid_feed_snapshot')
    await expectOnlyInputs()
    expect(await readFile(join(directory, feedName), 'utf8')).toBe(brokenFeed)
  }
})

test('rejects hardlinked inputs or a directory containing names of live native files', async () => {
  const aliasPath = join(directory, 'linked-usage.jsonl')
  await link(join(directory, usageName), aliasPath)
  await expect(prepareNativeUsageCleanup(directory, true)).rejects.toThrow('unsafe_or_changed_snapshot')
  await writeFile(join(directory, 'usage.jsonl'), 'synthetic-live-placeholder', { mode: 0o600 })
  await expect(prepareNativeUsageCleanup(directory, true)).rejects.toThrow('unsafe_offline_directory')
  expect(await readFile(join(directory, 'usage.jsonl'), 'utf8')).toBe('synthetic-live-placeholder')
  expect(await readdir(directory)).not.toContain(candidateName)
})
