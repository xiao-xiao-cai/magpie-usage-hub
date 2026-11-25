import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const keyId = 'fixture-key-id'
const reportKey = 'fixture-report-key'
const sourceRow = {
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
let stateFile: string
const hosts: Bun.Subprocess<'ignore', 'pipe', 'pipe'>[] = []

beforeEach(async () => {
  scratchRoot = await realpath(tmpdir())
  directory = await mkdtemp(join(scratchRoot, 'mpu-phase2-'))
  stateFile = join(directory, 'magpie-usage-hub', 'state.json')
  await writeFile(join(directory, 'fixture.key'), `${reportKey}\n`)
})

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(stopHost))
  const target = await realpath(directory)
  if (dirname(target) !== scratchRoot) throw new Error('unexpected test directory')
  await rm(target, { recursive: true })
})

function startHost(source: URL, center: URL, initialMode: 'now' | 'start' = 'now') {
  const options = {
    enabled: true,
    mode: 'continuous',
    sourceGatewayUrl: source.href,
    centralGatewayUrl: center.href,
    centralKeyFile: join(directory, 'fixture.key'),
    sourceCallerKeyId: keyId,
    initialMode,
    pollIntervalSec: 5,
    requestTimeoutSec: 15,
  }
  const host = Bun.spawn([process.execPath, '-e', `
    import plugin from './server.ts'
    const result = plugin.server({ directory: process.env.MPU_TEST_DIRECTORY }, JSON.parse(process.env.MPU_TEST_OPTIONS))
    if (JSON.stringify(result) !== '{}') process.exit(3)
  `], {
    cwd: join(import.meta.dir, '../..'),
    env: { ...process.env, MPU_TEST_DIRECTORY: directory, MPU_TEST_OPTIONS: JSON.stringify(options) },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  hosts.push(host)
  return host
}

async function stopHost(host: (typeof hosts)[number]): Promise<void> {
  if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL')
  await host.exited
}

async function readState() {
  return Bun.file(stateFile).json() as Promise<{ sourceInstanceId: string; cursor: string | null }>
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4_000) {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    if (await check()) return
    await Bun.sleep(30)
  }
  throw new Error('fixture observation timed out')
}

async function hasCursor(cursor: string): Promise<boolean> {
  return await Bun.file(stateFile).exists() && (await readState()).cursor === cursor
}

function fixturePage(cursor: string, rows: unknown[] = [], hasMore = false) {
  return Response.json({ rows, deleted: [], next_cursor: cursor, has_more: hasMore })
}

test('a temporary CLI parent cannot create sync state or read usage', async () => {
  let usageReads = 0
  const source = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/') return Response.json({ name: 'magpie', pid: process.pid + 1 })
      usageReads += 1
      return fixturePage('before')
    },
  })
  try {
    const host = startHost(source.url, new URL('https://center.example'))
    await waitFor(() => host.exitCode !== null)
    expect(await new Response(host.stderr).text()).toContain('source_owner_mismatch')
    expect(await Bun.file(stateFile).exists()).toBe(false)
    expect(usageReads).toBe(0)
  } finally {
    await source.stop(true)
  }
})

test('empty and excluded pages advance, with at most five pages in a round', async () => {
  const cursors: string[] = []
  const source = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/') return Response.json({ name: 'magpie', pid: process.pid })
      expect(url.searchParams.get('via')).toBe('through')
      expect(url.searchParams.get('callerKey')).toBe(keyId)
      cursors.push(url.searchParams.get('cursor') ?? '')
      return fixturePage(`page-${cursors.length}`, [{ origin: 'reported' }], true)
    },
  })
  try {
    const host = startHost(source.url, new URL('https://center.example'), 'start')
    await waitFor(async () => host.exitCode !== null || await hasCursor('page-5'))
    if (host.exitCode !== null) throw new Error(await new Response(host.stderr).text())
    await Bun.sleep(150)
    expect(cursors).toEqual(['start', 'page-1', 'page-2', 'page-3', 'page-4'])
    await stopHost(host)
    expect(await new Response(host.stdout).text()).toContain('"status":"ready"')
  } finally {
    await source.stop(true)
  }
})

test('a temporary center failure retries the same row and then saves the page', async () => {
  const requests: string[] = []
  const source = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/') return Response.json({ name: 'magpie', pid: process.pid })
      return fixturePage('after', url.searchParams.get('cursor') === 'start' ? [{ ...sourceRow, id: 'fixture' }] : [])
    },
  })
  const center = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const [record]: { rid: string }[] = await request.json()
      requests.push(record.rid)
      if (requests.length === 1) return new Response(null, { status: 503 })
      return Response.json({ accepted: 1, skipped: 0, records: [{ rid: record.rid, index: 0, status: 'accepted' }] })
    },
  })
  try {
    const host = startHost(source.url, center.url, 'start')
    await waitFor(() => requests.length === 1)
    expect((await readState()).cursor).toBeNull()
    await waitFor(() => hasCursor('after'), 16_000)
    expect(requests).toEqual([requests[0], requests[0]])
    await stopHost(host)
    expect(await new Response(host.stderr).text()).toContain('"status":"retrying","stage":"center"')
  } finally {
    await source.stop(true)
    await center.stop(true)
  }
}, 20_000)

test('handoff replays the entire page after a tail failure and a lost receipt', async () => {
  const requests: string[][] = []
  const ledger = new Set<string>()
  const pendingReceipt = Promise.withResolvers<void>()
  let sourceReads = 0
  let tailMode: 'reject' | 'hold' | 'confirm' = 'reject'
  let tailAccepted = false
  let hasFixtureRows = false
  const rows = Array.from({ length: 201 }, (_, index) => ({ ...sourceRow, id: `fixture-${index}` }))
  const source = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/') return Response.json({ name: 'magpie', pid: process.pid })
      expect(url.searchParams.get('callerKey')).toBe(keyId)
      expect(url.searchParams.get('via')).toBe('through')
      sourceReads += 1
      const cursor = url.searchParams.get('cursor')
      if (cursor === 'before' && hasFixtureRows) return fixturePage('after', rows)
      return fixturePage(cursor === 'after' ? 'after' : 'before')
    },
  })
  const center = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${reportKey}`)
      const body = await request.text()
      expect(body).not.toContain('private')
      expect(body).toContain('"cost":0')
      const records: { rid: string }[] = JSON.parse(body)
      requests.push(records.map((record) => record.rid))
      const tail = records.length === 1
      if (tail && tailMode === 'reject') return new Response(null, { status: 503, headers: { 'Retry-After': '950' } })
      let accepted = 0
      const receipts = records.map(({ rid }, index) => {
        if (ledger.has(rid)) return { rid, index, status: 'skipped' }
        ledger.add(rid)
        accepted += 1
        return { rid, index, status: 'accepted' }
      })
      if (tail && tailMode === 'hold') {
        tailAccepted = true
        await pendingReceipt.promise
      }
      return Response.json({ records: receipts, accepted, skipped: records.length - accepted })
    },
  })
  try {
    const first = startHost(source.url, center.url)
    await waitFor(() => hasCursor('before'))
    expect(requests).toHaveLength(0)
    const initial = await readState()
    hasFixtureRows = true
    await waitFor(() => requests.length === 2, 8_000)
    expect(ledger.size).toBe(200)
    expect(await readState()).toEqual(initial)

    const successor = startHost(source.url, center.url)
    const readsWhileLocked = sourceReads
    await Bun.sleep(1_200)
    expect(sourceReads).toBe(readsWhileLocked)
    expect(requests).toHaveLength(2)
    tailMode = 'hold'
    await stopHost(first)
    expect(await new Response(first.stderr).text()).toContain('"delayMs":950000')
    await waitFor(() => tailAccepted)
    expect(ledger.size).toBe(201)
    expect(await readState()).toEqual(initial)
    await stopHost(successor)
    pendingReceipt.resolve()

    tailMode = 'confirm'
    const last = startHost(source.url, center.url)
    await waitFor(() => hasCursor('after'))
    expect((await readState()).sourceInstanceId).toBe(initial.sourceInstanceId)
    expect(requests).toHaveLength(6)
    expect(requests.slice(2, 4)).toEqual(requests.slice(0, 2))
    expect(requests.slice(4, 6)).toEqual(requests.slice(0, 2))
    expect(ledger.size).toBe(201)
    await stopHost(last)
    const log = await new Response(last.stdout).text()
    expect(log).toContain('"status":"resumed"')
    expect(log).toContain('"accepted":0,"skipped":201')
    expect(log).not.toContain(reportKey)
  } finally {
    pendingReceipt.resolve()
    await source.stop(true)
    await center.stop(true)
  }
}, 20_000)
