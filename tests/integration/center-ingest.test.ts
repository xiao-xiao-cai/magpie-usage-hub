import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { checkIngestCredentials, serveIngest } from '../../src/center/ingest.ts'
import { openCenterLedger } from '../../src/center/ledger.ts'
import { postUsageBatch } from '../../src/gateway/client.ts'
import { mapUsageRow, type ReportRow } from '../../src/sync/mapping.ts'

const directoryPrefix = 'mpu-ingest-test-'
const sourceA = '550e8400-e29b-41d4-a716-446655440000'
const sourceB = '61bf719b-d7e1-4a95-a75b-4204e861735b'
const keyA = 'a'.repeat(64)
const keyB = 'b'.repeat(64)
const rotatedKey = 'c'.repeat(64)
const requestsPath = '/v1/magpie/usage/requests'
const maxBytes = 1024 * 1024

let scratchRoot: string
let directory: string
let keyFile: string
let ledgerPath: string
let database: ReturnType<typeof openCenterLedger>
let server: ReturnType<typeof serveIngest>

async function register(entries: { sourceInstanceId: string; key: string }[]): Promise<void> {
  await writeFile(keyFile, JSON.stringify(entries), { mode: 0o600 })
}

function report(id: string, overrides: Record<string, unknown> = {}, sourceInstanceId = sourceA): ReportRow {
  const mapped = mapUsageRow({
    origin: 'gateway', callerKeyId: 'trial', id, t: '2025-03-11T00:10:04.192637+08:00', agent: 'fixture',
    provider: 'fixture-provider', model: '合成模型', status: 200, in: 35, out: 12,
    cache_read: 3, cache_write: 9, cache_write_1h: 4, reasoning: 2,
    ms: 1000, ttft_ms: 300, first_text_ms: 345, flow_ms: 820, req: 'fixture-requested', served: 'fixture-served',
    effort: 'low', priced: false, ...overrides,
  }, sourceInstanceId, 'trial')
  if (mapped === null) throw new Error('missing_fixture_report')
  return mapped
}

function submit(body: BodyInit, key = keyA): Promise<Response> {
  return fetch(new URL(requestsPath, server.url), {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
    signal: AbortSignal.timeout(4000),
  })
}

function storedCount(): number | undefined {
  return database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM usage_reports').get()?.count
}

beforeEach(async () => {
  scratchRoot = await realpath(tmpdir())
  directory = await mkdtemp(join(scratchRoot, directoryPrefix))
  keyFile = join(directory, 'ingest-keys.json')
  ledgerPath = join(directory, 'usage.sqlite')
  await register([{ sourceInstanceId: sourceA, key: keyA }, { sourceInstanceId: sourceB, key: keyB }])
  database = openCenterLedger(ledgerPath)
  server = serveIngest(database, keyFile, 0, '127.0.0.1')
})

afterEach(async () => {
  await server.stop(true)
  database.close(true)
  const target = await realpath(directory)
  if (dirname(target) !== scratchRoot || !basename(target).startsWith(directoryPrefix)) {
    throw new Error('unexpected ingest test directory')
  }
  await rm(target, { recursive: true })
})

test('persists sender rows before responding and skips replay after reopen', async () => {
  const zero = report('zero', { priced: true, cost: 0 })
  const missing = report('missing', { status: 499, canceled: true })
  const rows = [zero, missing]
  const body = JSON.stringify(rows)
  const rids = rows.map(({ rid }) => rid)

  expect(await postUsageBatch(server.url, keyA, body, rids, 2000)).toEqual({ accepted: 2, skipped: 0 })
  await server.stop(true)
  database.close(true)
  database = openCenterLedger(ledgerPath)
  server = serveIngest(database, keyFile, 0, '127.0.0.1')

  expect(await postUsageBatch(server.url, keyA, body, rids, 2000)).toEqual({ accepted: 0, skipped: 2 })
  const stored = database.query<{ source_instance_id: string; called_at_ms: number; row_json: string }, [string]>(
    'SELECT source_instance_id, called_at_ms, row_json FROM usage_reports WHERE rid = ?',
  )
  for (const row of rows) {
    const actual = stored.get(row.rid)
    expect(actual?.source_instance_id).toBe(sourceA)
    expect(actual?.called_at_ms).toBe(Date.parse(row.t))
    expect(JSON.parse(actual?.row_json ?? 'null')).toEqual(row)
  }
  expect(JSON.parse(stored.get(zero.rid)?.row_json ?? '{}')).toHaveProperty('cost', 0)
  expect(JSON.parse(stored.get(missing.rid)?.row_json ?? '{}')).not.toHaveProperty('cost')
  expect(storedCount()).toBe(2)
})

test('skips a replay when the first committed receipt did not reach the sender', async () => {
  const row = report('lost-receipt')
  const body = JSON.stringify([row])
  const forwarded = Promise.withResolvers<number>()
  const releaseReceipt = Promise.withResolvers<void>()
  const relay = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(request) {
      const receipt = await fetch(new URL(requestsPath, server.url), {
        method: 'POST', headers: request.headers, body: await request.text(),
      })
      forwarded.resolve(receipt.status)
      await releaseReceipt.promise
      return receipt
    },
  })
  try {
    const sender = postUsageBatch(relay.url, keyA, body, [row.rid], 1000)
    const failed = expect(sender).rejects.toMatchObject({ stage: 'center', code: 'timeout' })
    expect(await forwarded.promise).toBe(200)
    expect(storedCount()).toBe(1)
    await failed
    expect(await postUsageBatch(server.url, keyA, body, [row.rid], 2000)).toEqual({ accepted: 0, skipped: 1 })
    expect(storedCount()).toBe(1)
  } finally {
    releaseReceipt.resolve()
    await relay.stop(true)
  }
})

test('isolates credentials and rotates one source without restarting ingestion', async () => {
  const first = report('equal-source-id')
  const other = report('equal-source-id', {}, sourceB)
  const assertions = [
    { body: [first], key: rotatedKey, status: 401 },
    { body: [first, other], key: keyA, status: 403 },
    { body: [first], key: keyB, status: 403 },
  ]
  for (const { body, key, status } of assertions) {
    expect((await submit(JSON.stringify(body), key)).status).toBe(status)
    expect(storedCount()).toBe(0)
  }

  expect(await postUsageBatch(server.url, keyB, JSON.stringify([other]), [other.rid], 2000))
    .toEqual({ accepted: 1, skipped: 0 })
  await register([{ sourceInstanceId: sourceA, key: rotatedKey }, { sourceInstanceId: sourceB, key: keyB }])
  expect((await submit(JSON.stringify([first]))).status).toBe(401)
  expect(await postUsageBatch(server.url, rotatedKey, JSON.stringify([first]), [first.rid], 2000))
    .toEqual({ accepted: 1, skipped: 0 })
  expect(await postUsageBatch(server.url, keyB, JSON.stringify([other]), [other.rid], 2000))
    .toEqual({ accepted: 0, skipped: 1 })
  expect(storedCount()).toBe(2)
})

test('stops accepting rows when the protected registry is malformed or ambiguous', async () => {
  await register([])
  await checkIngestCredentials(keyFile)
  const body = JSON.stringify([report('fixture')])
  expect((await submit(body)).status).toBe(401)
  await register([{ sourceInstanceId: sourceA, key: keyA }, { sourceInstanceId: sourceB, key: keyA }])
  await expect(checkIngestCredentials(keyFile)).rejects.toThrow('ingest_credentials_unavailable')
  expect((await submit(body)).status).toBe(503)
  await register([{ sourceInstanceId: sourceA, key: keyA }, { sourceInstanceId: sourceA, key: rotatedKey }])
  expect((await submit(body)).status).toBe(503)
  await writeFile(keyFile, '{')
  expect((await submit(body)).status).toBe(503)
  expect(storedCount()).toBe(0)
  if (process.platform !== 'win32') {
    await register([{ sourceInstanceId: sourceA, key: keyA }])
    await chmod(keyFile, 0o644)
    expect((await submit(body)).status).toBe(503)
  }
})

test('rejects a malformed member or duplicate RID without storing any part of the batch', async () => {
  const first = report('first')
  const second = report('second')
  for (const invalid of [
    first,
    { ...second, rid: `${second.rid}\n` },
    { ...second, t: '2025-02-30T14:12:00Z' },
    { ...second, t: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() },
    { ...second, prompt: 'synthetic-disallowed-field' },
    { ...second, in: -1 },
    { ...second, cache_write_1h: 99 },
    { ...second, first_text_ms: 299 },
    { ...second, cost: null },
    { ...second, err: 'synthetic-disallowed-error' },
  ]) {
    const response = await submit(JSON.stringify([first, invalid]))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'invalid_batch' } })
    expect(storedCount()).toBe(0)
  }
})

test('enforces both limits while allowing exactly 200 rows and exactly 1 MiB', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => report(`row-${index}`))
  expect((await submit(JSON.stringify(rows))).status).toBe(413)
  const rowJson = JSON.stringify(rows.slice(0, 1))
  const padding = ' '.repeat(maxBytes - Buffer.byteLength(rowJson))
  expect((await submit(`${padding} ${rowJson}`)).status).toBe(413)
  expect(storedCount()).toBe(0)
  expect((await submit(`${padding}${rowJson}`)).status).toBe(200)
  const body = JSON.stringify(rows.slice(0, 200))
  expect(await postUsageBatch(server.url, keyA, body, rows.slice(0, 200).map(({ rid }) => rid), 2000))
    .toEqual({ accepted: 199, skipped: 1 })
  expect(storedCount()).toBe(200)
})

test('checks streamed byte limits and decodes a split multibyte field', async () => {
  const row = report('streamed')
  const bytes = new TextEncoder().encode(JSON.stringify([row]))
  const split = bytes.findIndex((byte) => byte >= 128) + 1
  const stream = (...chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

  const padding = new Uint8Array(maxBytes - bytes.length + 1).fill(32)
  expect((await submit(stream(padding, bytes))).status).toBe(413)
  expect(storedCount()).toBe(0)
  expect((await submit(stream(bytes.slice(0, split), bytes.slice(split)))).status).toBe(200)
  expect(storedCount()).toBe(1)
})

test('rolls back an earlier insert on transaction error and can retry the same batch', async () => {
  const rows = [report('first'), report('second')]
  const body = JSON.stringify(rows)
  const rids = rows.map(({ rid }) => rid)
  database.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON usage_reports
    WHEN NEW.rid = '${rids[1]}' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`)

  const response = await submit(body)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: { code: 'ingest_ledger_unavailable' } })
  expect(storedCount()).toBe(0)
  database.exec('DROP TRIGGER reject_second')
  expect(await postUsageBatch(server.url, keyA, body, rids, 2000)).toEqual({ accepted: 2, skipped: 0 })
  expect(storedCount()).toBe(2)
})
