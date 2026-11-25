import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readTestOptions } from '../../src/options.ts'
import { mapUsageRow } from '../../src/sync/mapping.ts'
import { reportPage } from '../../src/sync/page.ts'
import { runTestOnce } from '../../src/test-run.ts'

const sourceId = '61bf719b-d7e1-4a95-a75b-4204e861735b'
const runId = '7d2752e7-b710-4a73-8e89-628bc870b361'
const keyId = 'fixture-key-id'
const sourceRow = {
  id: 'fixture-row',
  origin: 'gateway',
  callerKeyId: keyId,
  t: '2026-11-25T02:20:00Z',
  agent: 'fixture-agent',
  provider: 'fixture-provider',
  model: 'fixture-model',
  status: 200,
  in: 12,
  out: 5,
  priced: true,
  cost: 0,
  err: 'private upstream text',
  session: 'private session',
}

let scratchRoot: string
let directory: string

beforeEach(async () => {
  scratchRoot = await realpath(tmpdir())
  directory = await mkdtemp(join(scratchRoot, 'mpu-phase1-'))
})

afterEach(async () => {
  const target = await realpath(directory)
  if (dirname(target) !== scratchRoot) throw new Error('unexpected test directory')
  await rm(target, { recursive: true })
})

function testOptions(source: URL, center: URL) {
  return {
    enabled: true,
    runId,
    sourceId,
    sourceGatewayUrl: source.href,
    centralGatewayUrl: center.href,
    centralKeyFile: join(directory, 'fixture.key'),
    sourceCallerKeyId: keyId,
    sourceCursor: 'fixture-cursor',
  }
}

test('explicitly scoped options arm the test', () => {
  const base = testOptions(new URL('http://127.0.0.1:17425'), new URL('https://center.example'))
  expect(readTestOptions(undefined)).toBeNull()
  expect(readTestOptions({ enabled: false })).toBeNull()
  expect(readTestOptions(base)?.sourceCursor).toBe('fixture-cursor')
  expect(() => readTestOptions({ ...base, sourceCursor: 'start' })).toThrow('invalid_sourceCursor')
  expect(() => readTestOptions({ ...base, sourceCallerKeyId: 'none' })).toThrow('invalid_sourceCallerKeyId')
  expect(() => readTestOptions({ ...base, runId: '../escape' })).toThrow('invalid_runId')
  expect(() => readTestOptions({ ...base, sourceGatewayUrl: 'https://remote.example' })).toThrow('source_not_loopback')
  expect(() => readTestOptions({ ...base, centralGatewayUrl: 'https://center.example/v1' })).toThrow('invalid_centralGatewayUrl')
})

test('competing host invocations report exactly once and save a scoped result', async () => {
  let reads = 0
  let reports = 0
  const source = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      reads += 1
      const query = new URL(request.url).searchParams
      expect(query.get('cursor')).toBe('fixture-cursor')
      expect(query.get('callerKey')).toBe(keyId)
      return Response.json({ rows: [sourceRow], deleted: [], next_cursor: 'after', has_more: false })
    },
  })
  const center = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      reports += 1
      expect(request.headers.get('authorization')).toBe('Bearer fixture-report-key')
      const body = await request.text()
      expect(body).not.toContain('private')
      expect(body).toContain('"cost":0')
      const [record] = JSON.parse(body)
      return Response.json({ accepted: 1, skipped: 0, records: [{ index: 0, rid: record.rid, status: 'accepted' }] })
    },
  })

  try {
    const raw = testOptions(source.url, center.url)
    const options = readTestOptions(raw)
    if (options === null) throw new Error('test options unexpectedly disabled')
    await writeFile(raw.centralKeyFile, 'fixture-report-key\n')
    const results = await Promise.all([runTestOnce(directory, options), runTestOnce(directory, options)])
    const result = results.find((value) => value !== null)
    expect(results).toContain(null)
    expect(result).toMatchObject({ status: 'confirmed', accepted: 1, skipped: 0 })
    expect(await runTestOnce(directory, options)).toBeNull()
    expect(reads).toBe(1)
    expect(reports).toBe(1)
    const recorded = await readFile(join(directory, 'magpie-usage-hub', 'phase1', runId, 'result.json'), 'utf8')
    expect(JSON.parse(recorded)).toEqual(result)
    expect(recorded).not.toContain('fixture-report-key')
    expect(recorded).not.toContain('fixture-cursor')
  } finally {
    await source.stop(true)
    await center.stop(true)
  }
})

test('an ambiguous live page sends nothing', async () => {
  let reports = 0
  const source = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch() {
      return Response.json({ rows: [sourceRow, { ...sourceRow, id: 'other' }], deleted: [], next_cursor: 'after', has_more: false })
    },
  })
  const center = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch() {
      reports += 1
      return new Response(null, { status: 500 })
    },
  })
  try {
    const raw = testOptions(source.url, center.url)
    const options = readTestOptions(raw)
    if (options === null) throw new Error('test options unexpectedly disabled')
    await writeFile(raw.centralKeyFile, 'fixture-report-key')
    expect(await runTestOnce(directory, options)).toEqual({ status: 'failed', stage: 'source', code: 'expected_one_test_row' })
    expect(reports).toBe(0)
  } finally {
    await source.stop(true)
    await center.stop(true)
  }
})

test('a later batch failure withholds the next cursor', async () => {
  let batches = 0
  let rejectTail = true
  const center = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      batches += 1
      const rows: { rid: string }[] = await request.json()
      if (rows.length === 1 && rejectTail) return new Response(null, { status: 503 })
      return Response.json({
        accepted: rows.length,
        skipped: 0,
        records: rows.map((row, index) => ({ index, rid: row.rid, status: 'accepted' })),
      })
    },
  })
  try {
    const rows = Array.from({ length: 201 }, (_, index) => {
      const report = mapUsageRow({ ...sourceRow, id: `fixture-${index}` }, sourceId, keyId)
      if (report === null) throw new Error('fixture unexpectedly excluded')
      return report
    })
    await expect(reportPage(center.url, 'fixture-key', rows, 'after', 1_000)).rejects.toMatchObject({ stage: 'center', httpStatus: 503 })
    expect(batches).toBe(2)
    rejectTail = false
    expect(await reportPage(center.url, 'fixture-key', rows, 'after', 1_000)).toEqual({ nextCursor: 'after', accepted: 201, skipped: 0 })
  } finally {
    await center.stop(true)
  }
})
