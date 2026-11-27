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

test('the center isolates local feed outages and preserves remote history across lock handoff', async () => {
  const scratchRoot = await realpath(tmpdir())
  const directory = await mkdtemp(join(scratchRoot, 'mpu-center-runtime-'))
  const state = join(directory, 'state')
  const oldLedger = join(state, 'center', 'usage.sqlite')
  let owningPid = process.pid + 1
  const remoteKey = '1'.repeat(64)
  const digest = createHash('sha256').update(remoteKey).digest('hex')
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new URL(request.url).pathname === '/'
    ? Response.json({ name: 'magpie', pid: owningPid }) : new Response(null, { status: 503 }) })
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

  function startHost(marker: string, saveSource = false, collectionGateway = gateway.url) {
    const markerPath = join(directory, marker)
    const host = Bun.spawn([process.execPath, '-e', `
      import { rename } from 'node:fs/promises'
      import { runCenter } from './src/center/runtime.ts'
      import { createDiagnostics } from './src/diagnostics.ts'
      const diagnostics = createDiagnostics(null, 'center')
      const services = await runCenter(process.env.MPU_FIXTURE_STATE, {
        gateway: new URL(process.env.MPU_FIXTURE_GATEWAY), timeoutMs: 1000,
        ingestHost: '127.0.0.1', ingestPort: Number(process.env.MPU_FIXTURE_INGEST), timeZone: 'Asia/Shanghai',
      }, diagnostics)
      const api = 'http://127.0.0.1/api/sources'
      if (services && process.env.MPU_FIXTURE_SAVE === 'true') {
        const { revision } = await (await services.manage(new Request(api))).json()
        await services.manage(new Request(api, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revision, action: 'create', name: 'fixture', digest: process.env.MPU_FIXTURE_DIGEST }),
        }))
      }
      const saved = services ? await (await services.manage(new Request(api))).json() : null
      const history = services ? await (await services.dashboard(new URL('http://127.0.0.1/api/usage?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z'),
        AbortSignal.timeout(1000))).json() : null
      const marker = process.env.MPU_FIXTURE_MARKER
      const { phase } = diagnostics.getStatus()
      await Bun.write(marker + '.tmp', JSON.stringify({ phase, saved, history }))
      await rename(marker + '.tmp', marker)
      if (services) await Bun.sleep(60_000)
    `], {
      cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      env: { ...process.env, MAGPIE_ADDR: gateway.url.host, MPU_FIXTURE_INGEST: String(ingestPort),
        MPU_FIXTURE_STATE: state, MPU_FIXTURE_GATEWAY: collectionGateway.href,
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
    const wrongOwner = startHost('blocked.json', true)
    await waitFor(wrongOwner.hasMarker)
    expect(await wrongOwner.host.exited).toBe(0)
    expect(await wrongOwner.observation()).toEqual({ phase: 'blocked', saved: null, history: null })
    expect(await Bun.file(join(state, 'push', 'center.sqlite')).exists()).toBe(false)

    owningPid = process.pid
    const first = startHost('first.json', true)
    await waitFor(first.hasMarker)
    const configuration = await first.observation()
    expect(configuration).toMatchObject({ phase: 'ready', saved: { sources: [{ id: 'local' }, { name: 'fixture' }] } })
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

    const successor = startHost('successor.json', false, foreignGateway.url)
    await Bun.sleep(1_200)
    expect(successor.host.exitCode).toBeNull()
    expect(await successor.hasMarker()).toBe(false)
    await stopHost(first.host)
    await waitFor(successor.hasMarker)
    const next = await successor.observation()
    expect(next).toMatchObject({ phase: 'ready', saved: { sources: [{ id: 'local' }, { name: 'fixture' }] }, history: { sources: [
      { id: 'local', hasPublishedData: false }, { transport: 'otlp', phase: 'receiving',
        hasPublishedData: true, totals: { calls: 1, input: 5, output: 2 } },
    ] } })
    expect(next).not.toEqual(configuration)
    expect((await fetch(receiver, { method: 'POST' })).status).toBe(401)
    expect(await (await fetch(receiver, { method: 'POST', headers, body })).json()).toEqual({})
    expect(foreignFeedReads).toBe(0)
    expect(await readFile(oldLedger, 'utf8')).toBe('fixture legacy ledger')
  } finally {
    await Promise.all(hosts.map(stopHost))
    await gateway.stop(true)
    await foreignGateway.stop(true)
    const target = await realpath(directory)
    if (dirname(target) !== scratchRoot) throw new Error('unexpected test directory')
    await rm(target, { recursive: true })
  }
}, 15_000)
