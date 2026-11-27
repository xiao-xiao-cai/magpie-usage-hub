import { expect, test } from 'bun:test'
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

test('pull configuration stays with the gateway owner and reopens only after the lock hands off', async () => {
  const scratchRoot = await realpath(tmpdir())
  const directory = await mkdtemp(join(scratchRoot, 'mpu-center-runtime-'))
  const state = join(directory, 'state')
  const oldLedger = join(state, 'center', 'usage.sqlite')
  let owningPid = process.pid + 1
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ name: 'magpie', pid: owningPid }) })
  const hosts: Bun.Subprocess<'ignore', 'ignore', 'ignore'>[] = []

  function startHost(marker: string, saveSource = false) {
    const markerPath = join(directory, marker)
    const host = Bun.spawn([process.execPath, '-e', `
      import { rename } from 'node:fs/promises'
      import { runCenter } from './src/center/runtime.ts'
      import { createDiagnostics } from './src/diagnostics.ts'
      const diagnostics = createDiagnostics(null)
      const services = await runCenter(process.env.MPU_FIXTURE_STATE, {
        gateway: new URL(process.env.MPU_FIXTURE_GATEWAY), timeoutMs: 1000,
      }, diagnostics)
      const api = 'http://127.0.0.1/api/sources'
      if (services && process.env.MPU_FIXTURE_SAVE === 'true') await services.manage(new Request(api, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 0, name: 'fixture', gatewayUrl: 'https://fixture.example/', enabled: true, key: 'fixture-key' }),
      }))
      const saved = services ? await (await services.manage(new Request(api))).json() : null
      const marker = process.env.MPU_FIXTURE_MARKER
      const { phase } = diagnostics.getStatus()
      await Bun.write(marker + '.tmp', JSON.stringify({ phase, saved }))
      await rename(marker + '.tmp', marker)
      if (services) await Bun.sleep(60_000)
    `], {
      cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      env: { ...process.env, MPU_FIXTURE_STATE: state, MPU_FIXTURE_GATEWAY: gateway.url.href,
        MPU_FIXTURE_MARKER: markerPath, MPU_FIXTURE_SAVE: String(saveSource) },
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
    expect(await wrongOwner.observation()).toEqual({ phase: 'blocked', saved: null })
    expect(await Bun.file(join(state, 'pull', 'sources.json')).exists()).toBe(false)

    owningPid = process.pid
    const first = startHost('first.json', true)
    await waitFor(first.hasMarker)
    const configuration = await first.observation()
    expect(configuration).toMatchObject({ phase: 'ready', saved: { revision: 1, sources: [{ name: 'fixture' }] } })

    const successor = startHost('successor.json')
    await Bun.sleep(1_200)
    expect(successor.host.exitCode).toBeNull()
    expect(await successor.hasMarker()).toBe(false)
    await stopHost(first.host)
    await waitFor(successor.hasMarker)
    expect(await successor.observation()).toEqual(configuration)
    expect(await readFile(oldLedger, 'utf8')).toBe('fixture legacy ledger')
  } finally {
    await Promise.all(hosts.map(stopHost))
    await gateway.stop(true)
    const target = await realpath(directory)
    if (dirname(target) !== scratchRoot) throw new Error('unexpected test directory')
    await rm(target, { recursive: true })
  }
}, 15_000)
