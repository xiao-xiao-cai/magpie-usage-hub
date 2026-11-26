import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

const usageSnapshot = 'usage.snapshot.jsonl'
const feedSnapshot = 'usage-feed.snapshot.jsonl'
const ridSnapshot = 'approved-rids.json'
const candidateName = 'usage.cleaned.candidate.jsonl'
const maxLineBytes = 1024 * 1024
const maxApprovalBytes = 4 * maxLineBytes
const windows = process.platform === 'win32'
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const reportedRid = /^mpu1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/
const recordKeys = new Set(['t', 'source', 'rid', 'computer', 'agent', 'provider', 'model'])
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

class CleanupError extends Error {}

type Snapshot = { path: string; metadata: BigIntStats }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkSnapshot(current: BigIntStats, expected: BigIntStats): void {
  if (!current.isFile() || current.nlink !== 1n || current.dev !== expected.dev || current.ino !== expected.ino
    || current.size !== expected.size || current.mtimeNs !== expected.mtimeNs || current.ctimeNs !== expected.ctimeNs) {
    throw new CleanupError('unsafe_or_changed_snapshot')
  }
}

async function describeSnapshot(path: string): Promise<Snapshot> {
  const metadata = await lstat(path, { bigint: true })
  checkSnapshot(metadata, metadata)
  return { path, metadata }
}

async function useSnapshot<Result>(snapshot: Snapshot, read: (file: FileHandle, size: bigint) => Promise<Result>): Promise<Result> {
  const { path, metadata } = snapshot
  const file = await open(path, constants.O_RDONLY | (windows ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW))
  try {
    checkSnapshot(await file.stat({ bigint: true }), metadata)
    const result = await read(file, metadata.size)
    checkSnapshot(await file.stat({ bigint: true }), metadata)
    return result
  } finally {
    await file.close()
  }
}

async function* readLines(file: FileHandle, invalid: string): AsyncGenerator<Buffer> {
  let pending: Buffer = Buffer.alloc(0)
  for (;;) {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    const chunk = buffer.subarray(0, bytesRead)
    const bytes = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    let start = 0
    for (;;) {
      const newline = bytes.indexOf(10, start)
      if (newline === -1) break
      if (newline - start >= maxLineBytes) throw new CleanupError(invalid)
      yield bytes.subarray(start, newline + 1)
      start = newline + 1
    }
    pending = bytes.subarray(start)
    if (pending.length >= maxLineBytes) throw new CleanupError(invalid)
  }
  if (pending.length !== 0) throw new CleanupError(invalid)
}

function parseRecord(line: Buffer, invalid: string): Record<string, unknown> {
  try {
    const text = decoder.decode(line)
    const data: unknown = JSON.parse(text)
    if (!isRecord(data)) throw new Error()
    const names = new Set<string>()
    let depth = 0
    for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"(\s*:)?|([{}[\]])/g)) {
      if (token[2]) depth += token[2] === '{' || token[2] === '[' ? 1 : -1
      else if (depth === 1 && token[1]) {
        const name: string = JSON.parse(token[0].slice(0, -token[1].length))
        const folded = name.toUpperCase().toLowerCase()
        if (names.has(folded) || (recordKeys.has(folded) && name !== folded)) throw new Error()
        names.add(folded)
      }
    }
    return data
  } catch {
    throw new CleanupError(invalid)
  }
}

async function readApproval(snapshot: Snapshot): Promise<Set<string>> {
  return useSnapshot(snapshot, async (file, size) => {
    if (size > BigInt(maxApprovalBytes)) throw new CleanupError('invalid_approved_rids')
    let values: unknown
    try {
      values = JSON.parse(decoder.decode(await file.readFile()))
    } catch {
      throw new CleanupError('invalid_approved_rids')
    }
    if (!Array.isArray(values) || values.length === 0) throw new CleanupError('invalid_approved_rids')
    const approved = new Set<string>()
    for (const rid of values) {
      if (typeof rid !== 'string' || rid.length !== 106 || !reportedRid.test(rid) || approved.has(rid)) {
        throw new CleanupError('invalid_approved_rids')
      }
      approved.add(rid)
    }
    return approved
  })
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecordTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || value !== value.trim() || !rfc3339.test(value) || !Number.isFinite(Date.parse(value))) {
    return false
  }
  const day = value.slice(0, 10)
  const midnight = new Date(`${day}T00:00:00Z`)
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().slice(0, 10) === day
}

async function inspectFeed(snapshot: Snapshot): Promise<{ lines: number; sha256: string }> {
  return useSnapshot(snapshot, async (file) => {
    const invalid = 'invalid_feed_snapshot'
    const hash = createHash('sha256')
    let lines = 0
    for await (const bytes of readLines(file, invalid)) {
      const record = parseRecord(bytes, invalid)
      if (lines === 0) {
        const { epoch, s: seq = 0, floor = 0 } = record
        if (Object.keys(record).some((key) => !['epoch', 's', 'floor'].includes(key)) || typeof epoch !== 'string'
          || epoch.length !== 16 || !/^[0-9a-f]{16}$/.test(epoch) || !isNonnegativeInteger(seq)
          || !isNonnegativeInteger(floor) || floor > seq) throw new CleanupError(invalid)
      } else {
        const { s: seq, i: id, v: version, g: gone = false, t: at, k: key } = record
        const hasVersion = typeof version === 'string' && /^[0-9a-f]{1,16}$/.test(version) && version.trim() === version
        if (Object.keys(record).some((field) => !['s', 'i', 'v', 'g', 't', 'k'].includes(field))
          || !isNonnegativeInteger(seq) || seq === 0 || typeof id !== 'string' || id.length !== 22
          || !/^u_[0-9a-f]{20}$/.test(id) || (key !== undefined && typeof key !== 'string')
          || typeof gone !== 'boolean' || (gone ? !isNonnegativeInteger(at) || at === 0 || (version !== undefined && !hasVersion)
            : at !== undefined || !hasVersion)) throw new CleanupError(invalid)
      }
      hash.update(bytes)
      lines += 1
    }
    if (lines === 0) throw new CleanupError(invalid)
    return { lines, sha256: hash.digest('hex') }
  })
}

async function inspectUsage(snapshot: Snapshot, approved: Set<string>, output?: FileHandle) {
  return useSnapshot(snapshot, async (file) => {
    const invalid = 'invalid_usage_snapshot'
    const original = createHash('sha256')
    const retained = createHash('sha256')
    const remaining = new Set(approved)
    let originalRows = 0
    let retainedRows = 0
    let pendingWrites: Buffer[] = []
    let pendingBytes = 0
    for await (const bytes of readLines(file, invalid)) {
      const { t, source, rid, computer, agent, provider, model } = parseRecord(bytes, invalid)
      if (!isRecordTimestamp(t) || [agent, provider, model].some((value) => typeof value !== 'string') ||
        [source, rid, computer].some((value) => value !== undefined && typeof value !== 'string') ||
        (source === 'reported' && (typeof rid !== 'string' || rid.trim() === ''))) throw new CleanupError(invalid)
      original.update(bytes)
      originalRows += 1
      if (typeof rid === 'string' && approved.has(rid)) {
        if (source !== 'reported' || computer) throw new CleanupError('approved_rid_not_local_report')
        if (!remaining.delete(rid)) throw new CleanupError('duplicate_approved_rid_match')
        continue
      }
      retained.update(bytes)
      retainedRows += 1
      if (output) {
        pendingWrites.push(bytes)
        pendingBytes += bytes.length
        if (pendingBytes >= 256 * 1024) {
          await output.writeFile(Buffer.concat(pendingWrites, pendingBytes))
          pendingWrites = []
          pendingBytes = 0
        }
      }
    }
    if (remaining.size !== 0) throw new CleanupError('missing_approved_rid_match')
    if (output && pendingBytes > 0) await output.writeFile(Buffer.concat(pendingWrites, pendingBytes))
    return {
      original: { rows: originalRows, sha256: original.digest('hex') },
      retained: { rows: retainedRows, sha256: retained.digest('hex') },
      removedRows: originalRows - retainedRows,
    }
  })
}

export async function prepareNativeUsageCleanup(path: string, writeCandidate = false) {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || (!windows && (metadata.mode & 0o077) !== 0)) {
    throw new CleanupError('unsafe_offline_directory')
  }
  const directory = await realpath(path)
  for (const name of ['usage.jsonl', 'usage-feed.jsonl']) {
    if (await lstat(join(directory, name), { throwIfNoEntry: false })) throw new CleanupError('unsafe_offline_directory')
  }
  const snapshots = [usageSnapshot, feedSnapshot, ridSnapshot].map((name) => describeSnapshot(join(directory, name)))
  const [usage, journal, approval] = await Promise.all(snapshots)
  const approved = await readApproval(approval)
  const feed = await inspectFeed(journal)
  const checkInputs = () => Promise.all([usage, journal, approval].map(async ({ path: input, metadata: original }) => {
    checkSnapshot(await lstat(input, { bigint: true }), original)
  }))
  if (!writeCandidate) {
    const result = await inspectUsage(usage, approved)
    await checkInputs()
    return { ...result, feed }
  }

  const temporary = join(directory, `.usage-cleanup-${randomUUID()}.tmp`)
  const output = await open(temporary, 'wx', 0o600)
  try {
    let result: Awaited<ReturnType<typeof inspectUsage>>
    try {
      result = await inspectUsage(usage, approved, output)
      await output.sync()
    } finally {
      await output.close()
    }
    await checkInputs()
    await link(temporary, join(directory, candidateName))
    return { ...result, feed }
  } finally {
    await unlink(temporary)
  }
}

if (import.meta.main) {
  const [directory, option, ...rest] = Bun.argv.slice(2)
  if (!directory || rest.length > 0 || (option !== undefined && option !== '--write-candidate')) {
    console.error('Usage: bun scripts/prepare-native-usage-cleanup.ts <offline-dir> [--write-candidate]')
    process.exitCode = 2
  } else {
    try {
      console.log(JSON.stringify(await prepareNativeUsageCleanup(directory, option === '--write-candidate')))
    } catch (error) {
      console.error(error instanceof CleanupError ? error.message : 'cleanup_file_unavailable')
      process.exitCode = 1
    }
  }
}
