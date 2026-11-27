import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const [archiveArg, executableArg] = process.argv.slice(2)
assert(archiveArg && executableArg, 'Pass the candidate npm archive and installed magpie.exe')
const archive = resolve(archiveArg)
const executable = resolve(executableArg)
assert(archive.endsWith('.tgz') && executable.toLowerCase().endsWith('magpie.exe'))
const work = resolve(import.meta.dir, '../../.magpie-dev/otlp-host')
await mkdir(work, { recursive: true })
const stage = await mkdtemp(join(work, 'session-'))
const packageRoot = join(stage, 'package')
const diagnosticPort = 3493
const ingestPort = 35307
const providerPort = 35407
const provider = 'usage-hub-phase7-fixture'
const model = `${provider}/phase4-fixture-v1`
const queryHeader = 'X-Magpie-Usage-Query'
const adminHeader = 'X-Magpie-Usage-Admin'
const loopback = (port: number) => `http://127.0.0.1:${port}`
const directModel = 'usage-hub-otlp-session'

type Page = { name: string; spec: string; url: string; service: string }
type Profile = Awaited<ReturnType<typeof makeProfile>>
type WebPage = { page: Page; cookie: string; pageUrl: URL; proxy: URL; version: string }
type NativeRow = { t: string; model: string; origin: string; computer?: string; in: number; out: number }
type NativeTotals = { calls: number; input: number; output: number; cache_read: number; cache_write: number; cost: number; unpriced: number }
type NativeUsage = { through: NativeTotals; direct: NativeTotals }
type Detail = { sourceId: string; t: string; model: string; via: string; input: number; output: number }
type Totals = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; unpriced: number }
type Summary = { id: string; totals: Totals; buckets: { from: string; to: string; totals: Totals }[] }
type Source = { id: string; isLocal: boolean; transport: string; phase: string; credentials: { current: boolean } }

async function makeProfile(name: string, gatewayPort: number, webPort: number) {
  const directory = join(stage, name)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('MAGPIE_')))
  for (const [key, child] of Object.entries({
    USERPROFILE: 'home', HOME: 'home', APPDATA: 'roaming', LOCALAPPDATA: 'local',
    XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', TEMP: 'tmp', TMP: 'tmp',
  })) {
    const path = join(directory, child)
    env[key] = path
    await mkdir(path, { recursive: true })
  }
  const webKey = randomBytes(16).toString('hex')
  const codexDirectory = join(directory, 'home', '.codex')
  Object.assign(env, {
    MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`, MAGPIE_BUN: process.execPath,
    MAGPIE_NAME: `Usage Hub OTLP ${name}`, MAGPIE_WEB_KEY: webKey,
    MAGPIE_NO_ACCOUNTS: '1', NO_PROXY: '127.0.0.1,localhost', CODEX_HOME: codexDirectory,
  })
  return { name, directory, env, gatewayPort, webPort, webKey, codexDirectory, gateway: loopback(gatewayPort), web: loopback(webPort),
    host: undefined as ChildProcess | undefined }
}

function portFree(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = createServer()
    socket.once('error', () => done(false))
    socket.listen(port, '127.0.0.1', () => socket.close(() => done(true)))
  })
}

async function waitFor<Value>(label: string, timeoutMs: number, read: () => Promise<Value | undefined>): Promise<Value> {
  const deadline = performance.now() + timeoutMs
  do {
    const value = await read().catch(() => undefined)
    if (value !== undefined) return value
    await Bun.sleep(250)
  } while (performance.now() < deadline)
  throw new Error(label)
}

function request(url: string | URL, init?: RequestInit) {
  return fetch(url, { ...init, redirect: 'manual', signal: init?.signal ?? AbortSignal.timeout(3_000) })
}

async function json<Value>(response: Response, label: string, expected = 200): Promise<Value> {
  assert(response.status === expected, `${label}: HTTP ${response.status}`)
  return response.json() as Promise<Value>
}

async function cli(profile: Profile, ...args: string[]) {
  try {
    const { stdout } = await exec(executable, args, { cwd: profile.directory, env: profile.env, timeout: 30_000, windowsHide: true })
    return stdout.trim()
  } catch {
    throw new Error(`${profile.name} magpie command failed (${args.slice(0, 2).join(' ')})`)
  }
}

function spawnQuiet(executable: string, args: string[], options?: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(executable, args, { ...options, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  return child
}

async function stopProcess(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await Promise.race([exited, Bun.sleep(3_000)])
}

async function stopHost(profile: Profile, ownsDiagnostic = false) {
  if (!profile.host) return
  await stopProcess(profile.host)
  profile.host = undefined
  const ports = [profile.gatewayPort, profile.webPort, ...(ownsDiagnostic ? [diagnosticPort, ingestPort] : [])]
  for (const port of ports) {
    await waitFor(`${profile.name} did not release port ${port}`, 8_000, async () => await portFree(port) ? true : undefined)
  }
}

async function launchHost(profile: Profile) {
  for (const port of [profile.gatewayPort, profile.webPort]) assert(await portFree(port), `isolated port ${port} is occupied`)
  profile.host = spawnQuiet(executable, ['serve', `--web=127.0.0.1:${profile.webPort}`],
    { cwd: profile.directory, env: profile.env })
}

async function signIn(profile: Profile) {
  const identity = await waitFor(`${profile.name} gateway did not open`, 20_000, async () => {
    return json<{ pid: number; version: string }>(await request(`${profile.gateway}/`), 'isolated gateway identity')
  })
  assert(identity.pid === profile.host?.pid, `${profile.name} gateway PID differs from its isolated Web process`)
  const anonymous = await waitFor(`${profile.name} Web did not open`, 20_000, () => request(`${profile.web}/api/plugin-pages`))
  assert(anonymous.status === 401, `${profile.name} anonymous plugin listing: HTTP ${anonymous.status}`)
  const login = await request(`${profile.web}/_magpie/sign-in`, {
    method: 'POST', body: new URLSearchParams({ key: profile.webKey, back: '/' }),
  })
  assert(login.status === 303, `${profile.name} Web sign-in: HTTP ${login.status}`)
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0]
  assert(cookie, `${profile.name} Web login did not set a cookie`)
  const pages = await json<Page[]>(await request(`${profile.web}/api/plugin-pages`, { headers: { Cookie: cookie } }), 'plugin pages')
  return { cookie, pages, version: identity.version }
}

async function openCenter(profile: Profile): Promise<WebPage> {
  const { cookie, pages, version } = await signIn(profile)
  const page = pages.find(record => record.name === 'magpie-usage-hub')
  assert(page?.url && page.service, `${profile.name} missing installed plugin page or service route`)
  const pageUrl = new URL(page.url, profile.web)
  const proxy = new URL(page.service, pageUrl)
  assert(pageUrl.origin === profile.web && proxy.origin === profile.web, `${profile.name} page route origin mismatch`)
  const web = { page, cookie, pageUrl, proxy, version }
  await warmPage(web)
  return web
}

async function warmPage(web: WebPage) {
  const html = await request(web.pageUrl, { headers: { Cookie: web.cookie }, signal: AbortSignal.timeout(10_000) })
  assert(html.ok && /<html\b/iu.test(await html.text()), 'installed plugin page did not load')
}

async function showLocalSessions(web: string, cookie: string) {
  const settings = await request(new URL('/api/settings/gateway-mode', web), {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'off' }),
  })
  assert(settings.ok, `isolated local session visibility: HTTP ${settings.status}`)
}

async function options(web: WebPage, values?: Record<string, unknown>) {
  return json<Record<string, unknown>>(await request(new URL('/api/plugin-pages/options', web.proxy), {
    method: 'POST', headers: { Cookie: web.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec: web.page.spec, options: values }),
  }), 'native Options endpoint')
}

async function assertOptions(web: WebPage, expected: Record<string, unknown>, save = false) {
  const actual = await options(web, save ? expected : undefined)
  assert(Object.entries(expected).every(([name, value]) => actual[name] === value), 'native Options readback mismatch')
}

async function seedDirectSession(profile: Profile, time: number, sessionModel = directModel) {
  const timestamp = new Date(time).toISOString()
  const started = new Date(time - 1_000).toISOString()
  const directory = join(profile.codexDirectory, 'sessions', ...timestamp.slice(0, 10).split('-'))
  await mkdir(directory, { recursive: true })
  const id = crypto.randomUUID()
  const turnId = 'fixture-turn'
  const events = [
    { timestamp: started, type: 'session_meta', payload: { id, session_id: id, source: 'cli' } },
    { timestamp: started, type: 'turn_context', payload: { turn_id: turnId, model: sessionModel, effort: 'low' } },
    { timestamp, type: 'token_usage_record', payload: { response_id: `fixture-${id}`, session_id: id, thread_id: id, turn_id: turnId,
      usage: { input_tokens: 7, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 2,
        reasoning_output_tokens: 0, total_tokens: 9 } } },
  ]
  const datePrefix = timestamp.slice(0, 19).replaceAll(':', '-')
  await writeFile(join(directory, `rollout-${datePrefix}-${id}.jsonl`), `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
    { encoding: 'utf8', flag: 'wx' })
}

async function addModelCall(profile: Profile, key: string, throughCalls: number, directCalls = 1) {
  const response = await request(`${profile.gateway}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Usage Hub isolated acceptance' }], stream: false }),
  })
  assert(response.status === 200, `${profile.name} synthetic call: HTTP ${response.status}`)
  await response.body?.cancel()
  return waitFor(`${profile.name} native ledger did not record fixture call`, 10_000, async () => {
    const totals = await json<NativeUsage>(await request(`${profile.gateway}/v1/magpie/usage/requests?computer=this&period=7d&offset=0&limit=1`), 'native totals')
    if (totals.through.calls !== throughCalls || totals.direct.calls !== directCalls) return
    const feed = await json<{ rows: NativeRow[]; has_more: boolean }>(await request(`${profile.gateway}/v1/magpie/usage/requests?cursor=start&limit=100`), 'native changes')
    const rows = feed.rows.filter(row => !row.computer && (row.origin === 'gateway' || row.origin === 'session'))
    if (rows.length === throughCalls + directCalls && !feed.has_more) return { totals, rows }
  })
}

async function centerPages(web: WebPage, revision: string) {
  await request(web.proxy).catch(() => undefined)
  const sandbox = await waitFor('center did not apply its Options revision through the Web proxy', 25_000, async () => {
    const response = await request(new URL('api/status', web.proxy))
    const status = await json<{ ready: boolean; role: string; appliedRevision: string }>(response, 'proxied status')
    if (status.ready && status.role === 'center' && status.appliedRevision === revision) return response.headers.get('content-security-policy')
  })
  assert(sandbox?.includes('sandbox allow-scripts'), 'native proxy sandbox policy missing')
  const altered = new URL(web.proxy)
  altered.pathname = altered.pathname.replace(/\/[a-f0-9]{32}\//u, '/00000000000000000000000000000000/')
  assert(altered.pathname !== web.proxy.pathname, 'opaque proxy route token missing')
  assert((await request(new URL('api/status', altered))).status === 404, 'altered native route token was accepted')

  async function serviceToken(path: string, name: string) {
    const reply = await request(new URL(path, web.proxy), { headers: { Cookie: web.cookie } })
    assert(reply.status === 200, `proxied ${path}: HTTP ${reply.status}`)
    const token = (await reply.text()).match(new RegExp(`<meta name="${name}" content="([a-f0-9]{64})">`, 'u'))?.[1]
    assert(token, `proxied ${path} access token missing`)
    return token
  }

  const queryToken = await serviceToken('dashboard/', 'usage-query-token')
  const adminToken = await serviceToken('sources/', 'usage-admin-token')
  async function api(path: string, header?: [string, string], body?: object) {
    const headers = new Headers({ Cookie: web.cookie, Origin: 'null' })
    if (header) headers.set(...header)
    if (body) headers.set('Content-Type', 'application/json')
    return request(new URL(path, web.proxy), { headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined })
  }

  for (const [path, header, method] of [
    ['api/usage', queryHeader, 'GET'], ['api/usage/rows', queryHeader, 'GET'], ['api/sources', adminHeader, 'POST'],
  ]) {
    assert((await api(path)).status === 403, `${path} accepted a missing access token`)
    const preflight = await request(new URL(path, web.proxy), {
      method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': header },
    })
    const permits = (name: string, value: string) => preflight.headers.get(name)?.toLowerCase().split(/,\s*/u).includes(value.toLowerCase())
    assert(preflight.status === 204 && preflight.headers.get('Access-Control-Allow-Origin') === 'null'
      && permits('Access-Control-Allow-Headers', header) && permits('Access-Control-Allow-Methods', method),
    `${path} native proxy did not admit the sandboxed page's authorized request headers`)
  }
  assert((await api('api/usage/rows', [queryHeader, adminToken])).status === 403, 'detail endpoint accepted an admin token')
  assert((await api('api/sources', [adminHeader, queryToken])).status === 403, 'management endpoint accepted a query token')

  return {
    manage: async (body?: object) => json<{ revision: string; sources: Source[] }>(
      await api('api/sources', [adminHeader, adminToken], body), 'center management', body ? 201 : 200),
    summary: async (sourceId: string, filters?: Record<string, string>) => {
      const params = new URLSearchParams({ sourceId, ...filters })
      const result = await json<{ sources: Summary[] }>(await api(`api/usage?${params}`, [queryHeader, queryToken]), 'center summary')
      assert(result.sources.length === 1 && result.sources[0]?.id === sourceId, 'source filter returned the wrong scope')
      return result.sources[0]
    },
    rows: async (sourceId: string) => {
      const params = new URLSearchParams({ sourceId, limit: '10' })
      const result = await json<{ rows: Detail[]; nextPage: string | null }>(await api(`api/usage/rows?${params}`, [queryHeader, queryToken]), 'center details')
      assert(result.nextPage === null, 'tiny fixture was split into detail pages')
      return result.rows
    },
  }
}

async function reconcile(center: Awaited<ReturnType<typeof centerPages>>, sourceId: string, native: Awaited<ReturnType<typeof addModelCall>>) {
  const totals = (await center.summary(sourceId)).totals
  const comparisons = [ ['calls', 'calls'], ['input', 'input'], ['output', 'output'],
    ['cacheRead', 'cache_read'], ['cacheWrite', 'cache_write'], ['cost', 'cost'], ['unpriced', 'unpriced'] ] as const
  for (const [field, nativeField] of comparisons) {
    const expected = native.totals.through[nativeField] + native.totals.direct[nativeField]
    assert(Math.abs(totals[field] - expected) < 1e-9, `center and native ${field} disagree`)
  }
  const rows = await center.rows(sourceId)
  const expected = native.rows.map(row => [row.t, row.model, row.origin === 'gateway' ? 'through' : 'direct', row.in, row.out])
  const actual = rows.map(row => [row.t, row.model, row.via, row.input, row.output])
  assert(rows.every(row => row.sourceId === sourceId)
    && JSON.stringify(actual.map(row => JSON.stringify(row)).sort()) === JSON.stringify(expected.map(row => JSON.stringify(row)).sort()),
  'center rows differ from native original times, model or Token counts')
}

const [center, source] = await Promise.all([makeProfile('center', 35107, 35207), makeProfile('source', 35108, 35208)])
let fixture: ChildProcess | undefined
let relay: Bun.Server<undefined> | undefined
try {
  const { stdout } = await exec('tar.exe', ['-tf', archive], { windowsHide: true })
  const files = stdout.trim().split(/\r?\n/u)
  assert(files.every(file => /^package\/[\w@./-]+$/u.test(file) && !file.split('/').includes('..')), 'unexpected archive paths')
  for (const file of ['package/package.json', 'package/server.ts', 'package/page/index.html']) {
    assert(files.includes(file), `candidate archive is missing ${file}`)
  }
  await exec('tar.exe', ['-xf', archive, '-C', stage], { windowsHide: true })
  const manifest = await Bun.file(join(packageRoot, 'package.json')).json()
  assert(manifest.name === 'magpie-usage-hub' && manifest.version === '0.7.0' && manifest.magpie.page.service.port === diagnosticPort,
    'unexpected plugin candidate manifest')
  const archiveHash = createHash('sha256').update(new Uint8Array(await Bun.file(archive).arrayBuffer())).digest('hex')
  for (const port of [diagnosticPort, ingestPort, providerPort, center.gatewayPort, center.webPort, source.gatewayPort, source.webPort]) {
    assert(await portFree(port), `isolated port ${port} is occupied`)
  }
  fixture = spawnQuiet(process.execPath, [join(import.meta.dir, 'fixture-provider.ts'), String(providerPort)])
  await waitFor('fixture model provider did not open', 10_000, async () => (await request(`${loopback(providerPort)}/v1/models`)).ok ? true : undefined)
  await cli(center, 'plugin', 'add', packageRoot)
  const [centerModelKey, sourceModelKey] = await Promise.all([center, source].map(async profile => {
    await seedDirectSession(profile, Date.now() - 60_000, 'usage-hub-before-export')
    await cli(profile, 'sessions', 'read', 'on', 'codex')
    await cli(profile, 'provider', 'add', provider, `url=${loopback(providerPort)}/v1`, 'key=synthetic-provider-key', 'models=phase4-fixture-v1', 'list=off')
    const issued = JSON.parse(await cli(profile, 'gateway-key', 'issue', '--ttl', '2h', '--name', 'Usage Hub isolated model', '--models', model, '--json'))
    assert(typeof issued.key === 'string', `${profile.name} model key issuance failed`)
    return issued.key as string
  }))

  await launchHost(center)
  const centerWeb = await openCenter(center)
  assert((await options(centerWeb)).enabled !== true, 'center installation enabled reporting by default')
  await showLocalSessions(center.web, centerWeb.cookie)
  const centerNative = await addModelCall(center, centerModelKey, 1)
  const centerOptions = { enabled: true, collectionMode: 'otlp', role: 'center', centerGatewayUrl: center.gateway,
    requestTimeoutSec: 3, ingestHost: '127.0.0.1', ingestPort, timeZone: 'Asia/Shanghai', configRevision: crypto.randomUUID() }
  await assertOptions(centerWeb, centerOptions, true)
  await warmPage(centerWeb)
  const dashboard = await centerPages(centerWeb, centerOptions.configRevision)
  await assertOptions(centerWeb, centerOptions)
  await waitFor('center native call did not reach the center ledger', 15_000,
    async () => (await dashboard.summary('local')).totals.calls === 2 ? true : undefined)
  await reconcile(dashboard, 'local', centerNative)
  const receiver = `${loopback(ingestPort)}/v1/traces`
  const unauthorized = await request(receiver, { method: 'POST' })
  assert(unauthorized.status === 401, 'receiver accepted a missing reporting credential')

  let retryBatch: string | undefined
  let simulateFailure = false
  let attempts = 0
  let retryCompleted = false
  relay = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(input) {
    if (new URL(input.url).pathname !== '/v1/traces' || input.method !== 'POST') return new Response(null, { status: 404 })
    const headers = new Headers()
    for (const name of ['Authorization', 'Content-Type']) {
      const value = input.headers.get(name)
      if (value) headers.set(name, value)
    }
    const body = await input.arrayBuffer()
    if (simulateFailure) {
      const digest = createHash('sha256').update(new Uint8Array(body)).digest('hex')
      retryBatch ??= digest
      if (digest === retryBatch) {
        attempts += 1
        if (attempts === 1) return new Response(null, { status: 503 })
      }
    }
    const response = await request(receiver, { method: 'POST', headers, body })
    if (simulateFailure && response.ok) {
      if (attempts === 2) {
        await response.body?.cancel()
        return new Response(null, { status: 503 })
      }
      if (attempts === 3) retryCompleted = true
    }
    return response
  } })
  assert(relay.port, 'isolated receiver relay did not obtain a port')

  const reportKey = randomBytes(32).toString('hex')
  const before = await dashboard.manage()
  const digest = createHash('sha256').update(reportKey, 'ascii').digest('hex')
  const registered = await dashboard.manage({ action: 'create', name: 'Isolated Windows sender', digest, revision: before.revision })
  const registeredSource = registered.sources.find(item => !item.isLocal)
  assert(registeredSource?.credentials.current && registeredSource.transport === 'otlp' && registeredSource.phase === 'waiting',
    'registered source did not configure the reporting key')
  assert(!JSON.stringify(registered).includes(reportKey) && !JSON.stringify(registered).includes(digest), 'source credential escaped management')
  const sourceId = registeredSource.id

  await launchHost(source)
  const sourceWeb = await signIn(source)
  assert(sourceWeb.pages.every(page => page.name !== 'magpie-usage-hub'), 'source registered a Usage Hub plugin')
  await showLocalSessions(source.web, sourceWeb.cookie)
  const otel = { enabled: true, endpoint: loopback(relay.port), headers: { Authorization: `Bearer ${reportKey}` },
    metrics: false, sessions: true, bodies: false, bodiesWhole: false }
  const saved = await json<{ otel: typeof otel }>(await request(`${source.web}/api/settings`, {
    method: 'POST', headers: { Cookie: sourceWeb.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ otel }),
  }), 'native Observability preferences')
  assert(saved.otel?.enabled && saved.otel.endpoint === otel.endpoint && saved.otel.sessions && !saved.otel.bodies,
    'native Observability readback differs')

  await addModelCall(source, sourceModelKey, 1)
  await seedDirectSession(source, Date.now())
  await waitFor('native gateway and session generations did not reach the center', 25_000,
    async () => (await dashboard.summary(sourceId)).totals.calls === 2 ? true : undefined)
  const rows = await dashboard.rows(sourceId)
  const gatewayRow = rows.find(row => row.via === 'through')
  const sessionRow = rows.find(row => row.via === 'session')
  assert(gatewayRow && gatewayRow.model.endsWith('phase4-fixture-v1') && gatewayRow.input === 3 && gatewayRow.output === 1,
    'gateway attempt tokens or model differ')
  assert(sessionRow?.model === directModel && sessionRow.input === 5 && sessionRow.output === 2,
    'session exporter did not send the new local generation')
  assert(rows.every(row => row.sourceId === sourceId), 'unexpected remote source attribution')

  simulateFailure = true
  const callStartedAfter = Date.now()
  await addModelCall(source, sourceModelKey, 2, 2)
  const callRecordedBy = Date.now()
  await waitFor('native retry after the temporary failure and repeated commit did not succeed', 25_000,
    async () => retryCompleted ? true : undefined)
  const retriedRows = await dashboard.rows(sourceId)
  assert(retriedRows.length === 3, 'retry duplicated or dropped the generation')
  const retried = retriedRows.find(row => row.via === 'through' && row.t !== gatewayRow.t)
  assert(retried && Date.parse(retried.t) >= callStartedAfter && Date.parse(retried.t) <= callRecordedBy,
    'retry lost original call time')
  const originalTime = Date.parse(retried.t)
  const filtered = await dashboard.summary(sourceId, { from: new Date(originalTime).toISOString(),
    to: new Date(originalTime + 1).toISOString(), model: retried.model, via: 'through', bucket: 'hour' })
  assert(filtered.totals.calls === 1 && filtered.buckets.length === 1 && filtered.buckets[0].totals.calls === 1,
    'custom range and hourly bucket did not retain the retried call')

  await stopHost(source)
  await stopHost(center, true)
  await launchHost(center)
  await waitFor('cold center receiver did not start before page access', 20_000,
    async () => (await request(receiver, { method: 'POST' })).status === 401 ? true : undefined)
  const reopened = await openCenter(center)
  await assertOptions(reopened, centerOptions)
  const restored = await centerPages(reopened, centerOptions.configRevision)
  const sources = (await restored.manage()).sources
  assert(sources.some(item => item.id === sourceId && item.credentials.current && item.phase === 'receiving'), 'cold restart lost source registration')
  await reconcile(restored, 'local', centerNative)
  assert.deepEqual(await restored.rows(sourceId), retriedRows, 'cold restart lost remote history')

  console.log(JSON.stringify({ archiveVersion: manifest.version, archiveHash, bun: Bun.version,
    centerMagpie: centerWeb.version, sourceMagpie: sourceWeb.version, hostMode: 'serve --web',
    nativeObservability: true, sourceUsageHubInstalled: false, proxyAuthorization: true, proxyPreflight: true,
    receiverAuthorization: true, attempts, persistedHistory: true, initialSourceGatewaySpans: 1, sourceSessionSpans: 1,
    sourceUsageRows: retriedRows.length, centerCalls: 2, duplicateRows: 0, originalTimeBucket: true, coldCenterBeforePageAccess: true }))
} finally {
  try {
    await stopHost(source)
  } finally {
    try {
      await stopHost(center, true)
    } finally {
      relay?.stop(true)
      await stopProcess(fixture)
    }
  }
}
