import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { serveIngest } from '../../src/center/ingest.ts'
import { openCenterLedger } from '../../src/center/ledger.ts'
import { createSourceRegistry } from '../../src/center/sources.ts'
import { createDiagnostics } from '../../src/diagnostics.ts'
import { requestDirect } from '../../src/gateway/direct.ts'
import type { ManagedSourceOptions } from '../../src/options.ts'
import type { SyncState } from '../../src/state/store.ts'
import { openManagedSource } from '../../src/sync/managed.ts'

async function waitFor(check: () => boolean | Promise<boolean>) {
  const until = performance.now() + 8_000
  while (performance.now() < until) {
    if (await check()) return
    await Bun.sleep(30)
  }
  throw new Error('managed source fixture timed out')
}

test('recovers when the first pairing commits after the next config lookup', async () => {
  const root = await realpath(tmpdir())
  const directory = await mkdtemp(join(root, 'mpu-managed-sync-'))
  const pairingCodeFile = join(directory, 'fixture-code')
  const sourceInstanceId = crypto.randomUUID()
  let attempts = 0
  let pendingDigest: string | undefined
  let pairedDigest: string | undefined
  const center = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method === 'POST') {
      attempts += 1
      if (attempts === 1) {
        const { credentialDigest } = await request.json() as { credentialDigest: string }
        pendingDigest = credentialDigest
        return new Response(null, { status: 503 })
      }
      pairedDigest = pendingDigest
      return new Response(null, { status: 401 })
    }
    const bearer = request.headers.get('authorization')?.slice('Bearer '.length) ?? ''
    const digest = createHash('sha256').update(bearer).digest('hex')
    if (digest !== pairedDigest) return new Response(null, { status: 401 })
    return Response.json({ sourceInstanceId, enabled: true, sourceCallerKeyId: 'fixture-caller',
      sourceProviderId: 'fixture-provider', pollIntervalSec: 5 })
  } })
  try {
    await writeFile(pairingCodeFile, 'a'.repeat(64), { mode: 0o600 })
    const options: ManagedSourceOptions = { mode: 'managed', sourceGatewayUrl: new URL('http://127.0.0.1:3425/'),
      centralGatewayUrl: center.url, pairingCodeFile, requestTimeoutSec: 1 }
    const first = await openManagedSource(directory, options, createDiagnostics(null, false))
    await expect(first()).rejects.toMatchObject({ stage: 'center', code: 'upstream_failure' })
    const restarted = await openManagedSource(directory, options, createDiagnostics(null, false))
    expect(await restarted()).toMatchObject({ sourceInstanceId, enabled: true })
    expect(attempts).toBe(2)
  } finally {
    await center.stop(true)
    const target = await realpath(directory)
    if (dirname(target) !== root || !target.startsWith(join(root, 'mpu-managed-sync-'))) throw new Error('unexpected fixture directory')
    await rm(target, { recursive: true })
  }
})

test('managed source keeps identity after lost pairing and report replies, and resumes on center enable', async () => {
  const root = await realpath(tmpdir())
  const directory = await mkdtemp(join(root, 'mpu-managed-sync-'))
  const progress = join(directory, 'managed')
  const stateFile = join(progress, 'state.json')
  const registrationFile = Bun.file(join(progress, 'registration.json'))
  const readState = async () => JSON.parse(await readFile(stateFile, 'utf8')) as SyncState
  const hasCursor = async (cursor: string | null) => await Bun.file(stateFile).exists() && (await readState()).cursor === cursor
  const pairingCodeFile = join(directory, 'fixture-code')
  const hosts: Bun.Subprocess<'ignore', 'ignore', 'ignore'>[] = []
  const database = openCenterLedger(join(directory, 'center.sqlite'))
  const registry = createSourceRegistry(database)
  const node = registry.add({ name: 'fixture-windows', sourceCallerKeyId: 'fixture-caller', sourceProviderId: 'fixture-provider',
    enabled: false, pollIntervalSec: 5,
  })
  const { id } = node.source
  const center = serveIngest(database, undefined, 0, '127.0.0.1', registry)
  const receipts: { accepted: number; skipped: number }[] = []
  let pairCalls = 0
  let credentialPersistedBeforePair = false
  const relay = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const method = request.method === 'POST' ? 'POST' : 'GET'
    const headers = { Authorization: request.headers.get('authorization') ?? '', 'Content-Type': 'application/json' }
    if (path.endsWith('/pair')) {
      pairCalls += 1
      credentialPersistedBeforePair = await registrationFile.exists()
    }
    const response = await requestDirect(new URL(path, center.url), {
      method, headers, ...(method === 'POST' ? { body: await request.text() } : {}),
    }, AbortSignal.timeout(1_000))
    if (path.endsWith('/pair') && response.status === 204) return new Response(null, { status: 503 })
    if (path.endsWith('/requests') && response.ok) {
      const receipt: { accepted: number; skipped: number } = await response.json()
      receipts.push({ accepted: receipt.accepted, skipped: receipt.skipped })
      if (receipts.length === 1) return new Response(null, { status: 503 })
      return Response.json(receipt)
    }
    return response
  } })
  const sourceQueries: Record<string, string>[] = []
  let hasModelUsage = false
  const row = {
    id: 'fixture-native-row', origin: 'gateway', callerKeyId: node.source.sourceCallerKeyId, t: new Date().toISOString(),
    provider: node.source.sourceProviderId, model: 'fixture-model', agent: 'fixture-agent', status: 200,
    in: 12, out: 5, priced: true, cost: 0,
  }
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/') return Response.json({ name: 'magpie', pid: process.pid })
    const query = Object.fromEntries(url.searchParams)
    sourceQueries.push(query)
    const sendRow = query.cursor === 'fixture-before' && hasModelUsage
    return Response.json({ rows: sendRow ? [row] : [], deleted: [], has_more: false,
      next_cursor: sendRow || query.cursor === 'fixture-after' ? 'fixture-after' : 'fixture-before',
    })
  } })
  function startHost(codeFile?: string) {
    const options = { mode: 'managed', role: 'source', enabled: true, sourceGatewayUrl: gateway.url.href,
      centralGatewayUrl: relay.url.href, pairingCodeFile: codeFile,
    }
    const host = Bun.spawn([process.execPath, '-e', `
      import { createDiagnostics } from './src/diagnostics.ts'
      import { readManagedSourceOptions } from './src/options.ts'
      import { runContinuousSync } from './src/sync/continuous.ts'
      const options = readManagedSourceOptions(JSON.parse(process.env.MPU_MANAGED_OPTIONS))
      await runContinuousSync(process.env.MPU_MANAGED_DIRECTORY, options, createDiagnostics(null, false))
    `], {
      cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      env: { ...process.env, MPU_MANAGED_DIRECTORY: directory, MPU_MANAGED_OPTIONS: JSON.stringify(options) },
    })
    hosts.push(host)
    return host
  }
  async function stopHost(host: (typeof hosts)[number]) {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL')
    await host.exited
  }
  try {
    await writeFile(pairingCodeFile, node.pairingCode, { mode: 0o600 })
    const first = startHost(pairingCodeFile)
    await waitFor(() => registry.list()[0].paired)
    expect(credentialPersistedBeforePair).toBe(true)
    expect(await Bun.file(stateFile).exists()).toBe(false)
    await stopHost(first)

    const configured = startHost()
    await waitFor(() => hasCursor(null))
    expect(registry.list()[0].lastSeenAt).not.toBeNull()
    expect(sourceQueries).toEqual([])
    expect(pairCalls).toBe(1)

    const enabled = registry.edit(id, registry.list()[0].revision, { enabled: true, pollIntervalSec: 5 })
    expect(enabled?.source.enabled).toBe(true)
    await waitFor(() => hasCursor('fixture-before'))
    expect(sourceQueries).toEqual([{ cursor: 'now', via: 'through', limit: '500',
      callerKey: node.source.sourceCallerKeyId, provider: node.source.sourceProviderId,
    }])
    const checkpoint = await readState()
    expect(checkpoint.sourceInstanceId).toBe(id)
    hasModelUsage = true
    await waitFor(() => receipts.length === 1)
    expect(await readState()).toEqual(checkpoint)
    await stopHost(configured)

    startHost()
    await waitFor(() => hasCursor('fixture-after'))
    expect((await readState()).sourceInstanceId).toBe(id)
    expect(pairCalls).toBe(1)
    expect(sourceQueries.map(query => query.cursor)).toEqual(['now', 'fixture-before', 'fixture-before'])
    expect(receipts).toEqual([{ accepted: 1, skipped: 0 }, { accepted: 0, skipped: 1 }])
    const rid = `mpu1.${id}.${createHash('sha256').update(row.id).digest('hex')}`
    expect(database.query('SELECT rid FROM usage_reports').all()).toEqual([{ rid }])
    expect(registry.list()[0].lastReportAt).not.toBeNull()
  } finally {
    await Promise.all(hosts.map(stopHost))
    await Promise.all([gateway.stop(true), center.stop(true), relay.stop(true)])
    database.close(true)
    const target = await realpath(directory)
    if (dirname(target) !== root || !target.startsWith(join(root, 'mpu-managed-sync-'))) throw new Error('unexpected fixture directory')
    await rm(target, { recursive: true })
  }
}, 26_000)
