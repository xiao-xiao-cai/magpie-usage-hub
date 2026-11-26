import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readCenterOptions } from '../../src/center/runtime.ts'
import { postUsageBatch } from '../../src/gateway/client.ts'

test('center stays disabled by default and rejects a non-loopback gateway or a shared port', () => {
  expect(readCenterOptions({})).toBeNull()
  const options = { enabled: true, centerGatewayUrl: 'http://127.0.0.1:3425', ingestKeyFile: join(tmpdir(), 'fixture.json') }
  expect(readCenterOptions(options)).toMatchObject({ host: '127.0.0.1', port: 3494, timeoutMs: 30_000 })
  expect(readCenterOptions({ ...options, ingestKeyFile: undefined })?.keyFile).toBeUndefined()
  expect(() => readCenterOptions({ ...options, centerGatewayUrl: 'https://center.example' })).toThrow('center_not_loopback')
  expect(() => readCenterOptions({ ...options, ingestPort: 3493 })).toThrow('invalid_ingestPort')
  expect(() => readCenterOptions({ ...options, ingestPort: 3425 })).toThrow('invalid_ingestPort')
})

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await check()) return
    await Bun.sleep(30)
  }
  throw new Error('fixture observation timed out')
}

test('only the gateway owner can accept reports, and handoff keeps the ledger', async () => {
  const scratchRoot = await realpath(tmpdir())
  const directory = await mkdtemp(join(scratchRoot, 'mpu-center-runtime-'))
  let owningPid = process.pid + 1
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ name: 'magpie', pid: owningPid }) })
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = reservation.port!
  const address = new URL(`http://127.0.0.1:${port}`)
  await reservation.stop(true)
  const sourceInstanceId = randomUUID()
  const key = 'c'.repeat(64)
  const keyFile = join(directory, 'sources.json')
  const state = join(directory, 'state')
  const ledger = Bun.file(join(state, 'center', 'usage.sqlite'))
  const options = { enabled: true, centerGatewayUrl: gateway.url.href, ingestKeyFile: keyFile, ingestPort: port }
  const hosts: Bun.Subprocess<'ignore', 'ignore', 'ignore'>[] = []

  function startHost(marker: string) {
    const markerPath = join(directory, marker)
    const host = Bun.spawn([process.execPath, '-e', `
      import { rename } from 'node:fs/promises'
      import { readCenterOptions, runCenter } from './src/center/runtime.ts'
      import { createDiagnostics } from './src/diagnostics.ts'
      const diagnostics = createDiagnostics(null, true)
      const dashboard = await runCenter(process.env.MPU_FIXTURE_STATE, readCenterOptions(JSON.parse(process.env.MPU_FIXTURE_OPTIONS)), diagnostics)
      const marker = process.env.MPU_FIXTURE_MARKER
      await Bun.write(marker + '.tmp', JSON.stringify({ phase: diagnostics.getStatus().phase, dashboard: Boolean(dashboard) }))
      await rename(marker + '.tmp', marker)
    `], {
      cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      env: { ...process.env, MPU_FIXTURE_OPTIONS: JSON.stringify(options), MPU_FIXTURE_STATE: state, MPU_FIXTURE_MARKER: markerPath },
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

  const rid = `mpu1.${sourceInstanceId}.${'a'.repeat(64)}`
  const body = JSON.stringify([{ rid, t: new Date().toISOString(), agent: 'fixture', provider: 'fixture', model: 'fixture', status: 200 }])
  const report = () => postUsageBatch(address, key, body, [rid], 1_000)

  try {
    await writeFile(keyFile, JSON.stringify([{ sourceInstanceId, key }]), { mode: 0o600 })
    const wrongOwner = startHost('blocked.json')
    await waitFor(wrongOwner.hasMarker)
    expect(await wrongOwner.host.exited).toBe(0)
    expect(await wrongOwner.observation()).toEqual({ phase: 'blocked', dashboard: false })
    expect(await ledger.exists()).toBe(false)
    await expect(report()).rejects.toMatchObject({ code: 'network_error' })

    owningPid = process.pid
    const first = startHost('first.json')
    await waitFor(first.hasMarker)
    expect(await first.observation()).toEqual({ phase: 'receiving', dashboard: true })
    expect(await report()).toEqual({ accepted: 1, skipped: 0 })
    const successor = startHost('successor.json')
    await Bun.sleep(1_200)
    expect(successor.host.exitCode).toBeNull()
    expect(await successor.hasMarker()).toBe(false)
    expect(await report()).toEqual({ accepted: 0, skipped: 1 })

    await stopHost(first.host)
    await waitFor(successor.hasMarker)
    expect(await successor.observation()).toEqual({ phase: 'receiving', dashboard: true })
    expect(await report()).toEqual({ accepted: 0, skipped: 1 })
  } finally {
    await Promise.all(hosts.map(stopHost))
    await gateway.stop(true)
    const target = await realpath(directory)
    if (dirname(target) !== scratchRoot) throw new Error('unexpected test directory')
    await rm(target, { recursive: true })
  }
}, 15_000)
