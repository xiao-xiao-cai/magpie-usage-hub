import { expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openPullSources } from '../../src/center/sources.ts'

const fixtureKey = 'fixture-dedicated-read-key'
const draft = { revision: 0, name: '合成网关', gatewayUrl: 'https://fixture.example:3425', enabled: true, key: fixtureKey }

function request(method: string, value?: object, path = '/api/sources') {
  return new Request(`http://127.0.0.1${path}`, {
    method, ...(value && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
  })
}

async function withStateDirectory(check: (directory: string) => Promise<void>) {
  const root = await realpath(tmpdir())
  const directory = await mkdtemp(join(root, 'mpu-pull-sources-'))
  try {
    await check(directory)
  } finally {
    const target = await realpath(directory)
    if (dirname(target) !== root) throw new Error('unexpected test directory')
    await rm(target, { recursive: true })
  }
}

test('source management serializes revisions, keeps a stable ID, and reads back only safe fields', async () => {
  await withStateDirectory(async directory => {
    const path = join(directory, 'pull')
    const stateFile = join(path, 'sources.json')
    const { manage } = await openPullSources(path, 1_000)
    expect(await (await manage(request('GET'))).json()).toEqual({ revision: 0, sources: [] })

    const results = await Promise.all([manage(request('POST', draft)), manage(request('POST', draft))])
    expect(results.map(result => result.status).sort()).toEqual([201, 409])
    const serialized = await results.find(result => result.status === 201)!.text()
    const saved = JSON.parse(serialized)
    expect(serialized).not.toContain(fixtureKey)
    expect(saved).toEqual({ revision: 1, sources: [{ id: expect.any(String), name: draft.name,
      gatewayUrl: `${draft.gatewayUrl}/`, enabled: true, credentialConfigured: true }] })
    const { id } = saved.sources[0]
    expect((await manage(request('POST', { ...draft, revision: 1, id: 'invalid' }))).status).toBe(400)
    const unknown = await manage(request('POST', { ...draft, revision: 1, id: '1f2b4c0b-75cb-4fad-aa11-516e4f1808d8' }))
    expect(unknown.status).toBe(404)

    const edit = { ...draft, id, revision: 1, enabled: false, key: undefined }
    for (const path of ['/api/sources', '/api/sources/test']) {
      const rejected = await manage(request('POST', { ...edit, gatewayUrl: 'https://other.example' }, path))
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({ error: { code: 'key_required' } })
    }
    expect((await manage(request('POST', { ...edit, gatewayUrl: 'https://other.example/?' }))).status).toBe(400)
    expect((await manage(request('POST', edit))).status).toBe(200)
    const newKey = 'fixture-rotated-key'
    expect((await manage(request('POST', { ...edit, revision: 2, key: newKey, enabled: true }))).status).toBe(200)

    const reopened = await openPullSources(path, 1_000)
    expect(reopened.getSources()).toEqual([{ id, name: draft.name, gatewayUrl: `${draft.gatewayUrl}/`, enabled: true,
      key: newKey }])
    const restored = await (await reopened.manage(request('GET'))).text()
    expect(restored).not.toContain(newKey)
    expect(JSON.parse(restored)).toMatchObject({ revision: 3, sources: [{ id, credentialConfigured: true }] })
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o700)
      expect((await stat(stateFile)).mode & 0o777).toBe(0o600)
      await chmod(stateFile, 0o644)
      await expect(openPullSources(path, 1_000)).rejects.toMatchObject({ code: 'state_invalid' })
    }
  })
})

test('a failed commit keeps the published revision and allows the draft to be retried', async () => {
  await withStateDirectory(async directory => {
    const path = join(directory, 'pull')
    const backup = join(directory, 'pull-before-failure')
    const { manage } = await openPullSources(path, 1_000)
    const created = await manage(request('POST', draft))
    const { sources: [{ id }] } = await created.json()
    const previous = await (await manage(request('GET'))).text()
    const bytes = await readFile(join(path, 'sources.json'), 'utf8')
    await rename(path, backup)
    await writeFile(path, 'fixture write failure')
    const edit = { ...draft, id, revision: 1, enabled: false, key: undefined }
    const failed = await manage(request('POST', edit))
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ error: { code: 'source_save_failed' } })
    expect(await (await manage(request('GET'))).text()).toBe(previous)
    expect(await readFile(join(backup, 'sources.json'), 'utf8')).toBe(bytes)
    await rm(path)
    await rename(backup, path)
    expect((await manage(request('POST', edit))).status).toBe(200)
    expect(await (await manage(request('GET'))).json()).toMatchObject({ revision: 2, sources: [{ id, enabled: false }] })
  })
})

test('connection test checks the two native paths with the submitted key and classifies a restricted key', async () => {
  const observed: [string, string | null][] = []
  const zero = { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, unpriced: 0 }
  const gateway = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const authorization = request.headers.get('authorization')
      observed.push([url.pathname + url.search, authorization])
      if (url.pathname.endsWith('/requests')) return Response.json({ period: 'today', through: zero, direct: zero })
      if (authorization === 'Bearer fixture-restricted') {
        return Response.json({ error: { code: 'gateway_key_held', message: 'fixture-secret-details' } }, { status: 403 })
      }
      return Response.json({ period: 'today', since: '2026-11-27T00:00:00+08:00' })
    },
  })
  try {
    await withStateDirectory(async directory => {
      const { manage } = await openPullSources(join(directory, 'pull'), 1_000)
      const connection = { ...draft, gatewayUrl: gateway.url.href }
      const success = await manage(request('POST', connection, '/api/sources/test'))
      expect(await success.json()).toEqual({ checkedAt: expect.any(String), status: 'ok', failure: null })
      const failure = await manage(request('POST', { ...connection, key: 'fixture-restricted' }, '/api/sources/test'))
      expect(failure.status).toBe(200)
      expect(await failure.json()).toEqual({ checkedAt: expect.any(String), status: 'unavailable',
        failure: { code: 'restricted_key', httpStatus: 403 } })
      expect(observed).toEqual(['fixture-dedicated-read-key', 'fixture-restricted'].flatMap(key => [
        ['/v1/magpie/usage/requests?computer=this&period=today&offset=0&limit=1', `Bearer ${key}`],
        ['/v1/magpie/usage?period=today', `Bearer ${key}`],
      ]))
      expect(await (await manage(request('GET'))).json()).toEqual({ revision: 0, sources: [] })
    })
  } finally {
    await gateway.stop(true)
  }
})
