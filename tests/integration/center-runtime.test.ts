import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await check()) return
    await Bun.sleep(30)
  }
  throw new Error('fixture observation timed out')
}

test('the center isolates gateway and listener failures and preserves history across lock handoff', async () => {
  const scratchRoot = await realpath(tmpdir())
  const directory = await mkdtemp(join(scratchRoot, 'mpu-center-runtime-'))
  const state = join(directory, 'state')
  const oldLedger = join(state, 'center', 'usage.sqlite')
  let owningPid = process.pid + 1
  let enableLocalFeed = false
  const remoteKey = '1'.repeat(64)
  const digest = createHash('sha256').update(remoteKey).digest('hex')
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    const url = new URL(request.url)
    if (url.pathname === '/') return Response.json({ name: 'magpie', pid: owningPid })
    if (!enableLocalFeed) return new Response(null, { status: 503 })
    if (url.searchParams.get('cursor') === 'fixture-local') {
      return Response.json({ rows: [], deleted: [], next_cursor: 'fixture-local', has_more: false })
    }
    return Response.json({ rows: [{ id: 'u_' + 'c'.repeat(20), seq: 1, origin: 'gateway',
      t: '2026-11-27T08:15:00+08:00', model: 'local-fixture', in: 3, out: 4, cache_read: 0, cache_write: 0, priced: false }],
      deleted: [], next_cursor: 'fixture-local', has_more: false })
  } })
  let foreignFeedReads = 0
  const foreignGateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    if (new URL(request.url).pathname === '/') return Response.json({ name: 'magpie', pid: owningPid + 1 })
    foreignFeedReads += 1
    return new Response(null, { status: 503 })
  } })
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const ingestPort = probe.port!
  await probe.stop(true)
  const hosts: Bun.Subprocess<'ignore', 'ignore', 'ignore'>[] = []

  const configRevision = crypto.randomUUID()
  const center = { enabled: true, collectionMode: 'otlp', role: 'center', centerGatewayUrl: gateway.url.href,
    requestTimeoutSec: 1, ingestHost: '127.0.0.1', ingestPort, configRevision }
  function startHost(marker: string, settings: Record<string, unknown>, saveSource = false, stateDirectory = state) {
    const markerPath = join(directory, marker)
    const host = Bun.spawn([process.execPath, '-e', `
      import { rename } from 'node:fs/promises'
      import { runCenter } from './src/center/runtime.ts'
      import { createDiagnostics, serveDiagnostics } from './src/diagnostics.ts'
      import { readOptions } from './src/options.ts'
      const savedSettings = JSON.parse(process.env.MPU_FIXTURE_OPTIONS)
      const diagnostics = createDiagnostics(savedSettings.configRevision ?? null, 'center')
      const services = await runCenter(process.env.MPU_FIXTURE_STATE, readOptions(savedSettings, process.env.MAGPIE_ADDR), diagnostics)
      const api = 'http://127.0.0.1/api/sources'
      if (services && process.env.MPU_FIXTURE_SAVE === 'true') {
        const { revision } = await (await services.manage(new Request(api))).json()
        await services.manage(new Request(api, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revision, action: 'create', name: 'fixture', digest: process.env.MPU_FIXTURE_DIGEST }),
        }))
      }
      const saved = services ? await (await services.manage(new Request(api))).json() : null
      let history = null
      let status = diagnostics.getStatus()
      const until = performance.now() + 3000
      if (services) do {
        history = await (await services.dashboard(new URL('http://127.0.0.1/api/usage?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z'),
          AbortSignal.timeout(1000))).json()
        status = diagnostics.getStatus()
        if (process.env.MPU_FIXTURE_WAIT_LOCAL === 'true' ? history.sources[0].totals.calls > 0 : status.collectorFailure) break
        await Bun.sleep(20)
      } while (performance.now() < until)
      if (services) {
        const listener = serveDiagnostics(diagnostics, 0, services.dashboard, services.manage)
        status = await (await fetch(new URL('api/status', listener.url))).json()
        await listener.stop(true)
      }
      const marker = process.env.MPU_FIXTURE_MARKER
      await Bun.write(marker + '.tmp', JSON.stringify({ ...status, saved, history }))
      await rename(marker + '.tmp', marker)
      if (services) await Bun.sleep(60_000)
    `], {
      cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      env: { ...process.env, MAGPIE_ADDR: gateway.url.host, MPU_FIXTURE_STATE: stateDirectory,
        MPU_FIXTURE_OPTIONS: JSON.stringify(settings), MPU_FIXTURE_WAIT_LOCAL: String(enableLocalFeed),
        MPU_FIXTURE_MARKER: markerPath, MPU_FIXTURE_SAVE: String(saveSource), MPU_FIXTURE_DIGEST: digest },
    })
    hosts.push(host)
    return {
      host,
      hasMarker: () => access(markerPath).then(() => true, () => false),
      observation: async (): Promise<unknown> => JSON.parse(await readFile(markerPath, 'utf8')),
    }
  }

  async function stopHost(host: (typeof hosts)[number]): Promise<void> {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL')
    await host.exited
  }

  try {
    await mkdir(dirname(oldLedger), { recursive: true, mode: 0o700 })
    await writeFile(oldLedger, 'fixture legacy ledger', { mode: 0o600 })
    const wrongOwner = startHost('blocked.json', center, true)
    await waitFor(wrongOwner.hasMarker)
    expect(await wrongOwner.host.exited).toBe(0)
    expect(await wrongOwner.observation()).toMatchObject({ phase: 'blocked', receiver: 'off', collectorPhase: null,
      failure: { code: 'center_owner_mismatch' }, saved: null, history: null })
    expect(await Bun.file(join(state, 'push', 'center.sqlite')).exists()).toBe(false)

    owningPid = process.pid
    const first = startHost('first.json', center, true)
    await waitFor(first.hasMarker)
    const configuration = await first.observation()
    expect(configuration).toMatchObject({ phase: 'ready', receiver: 'listening', appliedRevision: configRevision,
      failure: null, collectorPhase: 'retrying', collectorFailure: { stage: 'source', code: 'unavailable', httpStatus: 503 },
      collectorRetryAt: expect.any(String), lastSyncedAt: null,
      saved: { sources: [{ id: 'local' }, { name: 'fixture' }] } })
    const receiver = `http://127.0.0.1:${ingestPort}/v1/traces`
    expect((await fetch(receiver, { method: 'POST' })).status).toBe(401)
    const headers = { Authorization: `Bearer ${remoteKey}`, 'Content-Type': 'application/json' }
    const start = BigInt(Date.parse('2026-11-27T08:15:00+08:00')) * 1_000_000n
    const body = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ scope: { name: 'github.com/yetone/magpie' }, spans: [{
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16), kind: 3,
      startTimeUnixNano: start.toString(), endTimeUnixNano: (start + 100_000_000n).toString(),
      attributes: [
        { key: 'langfuse.observation.type', value: { stringValue: 'generation' } },
        { key: 'gen_ai.request.model', value: { stringValue: 'fixture' } },
        ...Object.entries({ 'gen_ai.usage.input_tokens': '5', 'gen_ai.usage.output_tokens': '2',
          'gen_ai.usage.cache_read.input_tokens': '0', 'gen_ai.usage.cache_creation.input_tokens': '0',
          'gen_ai.usage.reasoning.output_tokens': '0' }).map(([key, intValue]) => ({ key, value: { intValue } })),
      ],
    }] }] }] })
    expect((await fetch(receiver, { method: 'POST', headers, body })).status).toBe(200)

    const successor = startHost('successor.json', { ...center, centerGatewayUrl: foreignGateway.url.href })
    await Bun.sleep(1_200)
    expect(successor.host.exitCode).toBeNull()
    expect(await successor.hasMarker()).toBe(false)
    await stopHost(first.host)
    await waitFor(successor.hasMarker)
    const next = await successor.observation()
    expect(next).toMatchObject({ phase: 'ready', collectorPhase: 'blocked', collectorFailure: { code: 'center_owner_mismatch' },
      saved: { sources: [{ id: 'local' }, { name: 'fixture' }] }, history: { sources: [
      { id: 'local', hasPublishedData: false }, { transport: 'otlp', phase: 'receiving',
        hasPublishedData: true, totals: { calls: 1, input: 5, output: 2 } },
    ] } })
    expect(next).not.toEqual(configuration)
    expect((await fetch(receiver, { method: 'POST' })).status).toBe(401)
    expect(await (await fetch(receiver, { method: 'POST', headers, body })).json()).toEqual({})
    expect(foreignFeedReads).toBe(0)

    await stopHost(successor.host)
    enableLocalFeed = true
    const conflicted = startHost('conflicted.json', { ...center, receiverEnabled: true, ingestPort: foreignGateway.port })
    await waitFor(conflicted.hasMarker)
    expect(await conflicted.observation()).toMatchObject({ phase: 'ready', ready: true, receiver: 'failed',
      loadedRevision: configRevision, appliedRevision: null, failure: { code: 'ingest_listener_unavailable' },
      collectorPhase: 'ready', collectorFailure: null, collectorRetryAt: null, syncPhase: 'sync', lastSyncedAt: expect.any(String),
      saved: { sources: [{ id: 'local' }, { name: 'fixture' }] }, history: { sources: [
        { id: 'local', totals: { calls: 1, input: 3 } }, { transport: 'otlp', totals: { calls: 1, input: 5 } },
      ] } })
    await stopHost(conflicted.host)
    const localOnly = startHost('local-only.json', { ...center, receiverEnabled: false })
    await waitFor(localOnly.hasMarker)
    expect(await localOnly.observation()).toMatchObject({ phase: 'ready', ready: true, receiver: 'off',
      appliedRevision: configRevision, failure: null, saved: { sources: [{ id: 'local' }, { name: 'fixture' }] },
      history: { sources: [{ id: 'local', totals: { calls: 1 } }, { transport: 'otlp', totals: { calls: 1 } }] } })
    const freePort = Bun.serve({ hostname: '127.0.0.1', port: ingestPort, fetch: () => new Response() })
    await freePort.stop(true)
    expect(await readFile(oldLedger, 'utf8')).toBe('fixture legacy ledger')

    await stopHost(localOnly.host)
    const fresh = startHost('fresh.json', {}, false, join(directory, 'fresh-state'))
    await waitFor(fresh.hasMarker)
    expect(await fresh.observation()).toMatchObject({ phase: 'ready', ready: true, receiver: 'off', loadedRevision: null,
      collectorPhase: 'ready', collectorFailure: null, lastPageAt: expect.any(String), lastSyncedAt: expect.any(String),
      saved: { sources: [{ id: 'local' }] }, history: { sources: [{ id: 'local', totals: { calls: 1, input: 3 } }] } })
  } finally {
    await Promise.all(hosts.map(stopHost))
    await gateway.stop(true)
    await foreignGateway.stop(true)
    const target = await realpath(directory)
    if (dirname(target) !== scratchRoot) throw new Error('unexpected test directory')
    await rm(target, { recursive: true })
  }
}, 15_000)
