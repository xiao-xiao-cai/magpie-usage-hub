import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const script = ['../../page/options.js', '../../ui/sources/onboarding.js', '../../ui/sources/sources.js']
  .map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')
const adminToken = 'b'.repeat(64)
const digest = 'a'.repeat(64)
const revisionOne = '11111111-1111-4111-8111-111111111111'
const revisionTwo = '22222222-2222-4222-8222-222222222222'
const revisionThree = '33333333-3333-4333-8333-333333333333'
const source = { id: 'b49664b2-d102-4e01-93b0-a67d696bd618', name: '合成来源', enabled: true, transport: 'otlp',
  phase: 'waiting', hasMore: false, lastSeenAt: null, lastPageAt: null, lastSyncedAt: null, recoveryReason: null,
  rebuildAllowed: false, gap: null, credentials: { current: true, pending: false, pendingVerified: false },
}

class Control extends EventTarget {
  checked = false
  disabled = false
  hidden = false
  href = ''
  value = ''
  textContent = ''
  children: Control[] = []
  get valueAsNumber() { return this.value.trim() ? Number(this.value) : NaN }
  append(child: Control) { this.children.push(child) }
  replaceChildren(...children: Control[]) { this.children = children }
  setAttribute() {}
  focus() {}
}

const endpoint = 'http://192.0.2.2:3494'

function fillDevice(ui: ReturnType<typeof harness>, respond = true) {
  ui.input('source-name', source.name)
  ui.input('source-digest', digest)
  ui.input('receiver-host', '192.0.2.2')
  ui.input('receiver-endpoint', endpoint)
  if (respond) ui.replyCreate()
}

function harness(sources: object[] = [source], config: Record<string, unknown> = {}, hash = '') {
  const controls = new Map<string, Control>()
  const requests: { path: string; init: RequestInit }[] = []
  const replies: (() => Promise<Response>)[] = []
  const writes: Record<string, unknown>[] = []
  const steps: string[] = []
  const location = new URL(`https://magpie.example/plugin/_magpie/service/sources/${hash}`)
  let saved = { ...config }
  const bridge = {
    async getOptions() { steps.push('get'); return { ...saved } },
    async setOptions(next: Record<string, unknown>) { steps.push('set'); writes.push(next); saved = { ...next } },
    backSearch: () => '?period=30d&via=conversation',
  }
  const runtime = { status: () => ({ schema: 'magpie-usage-hub/status-v1', role: 'center', ready: true, loadedRevision: saved.configRevision,
    appliedRevision: saved.configRevision, receiver: 'listening' }) }
  function control(id: string) {
    if (!controls.has(id)) controls.set(id, new Control())
    return controls.get(id)!
  }
  function reply(payload: unknown, status = 200) {
    replies.push(async () => Response.json(payload, { status }))
  }
  function lastBody() {
    return JSON.parse(String(requests.at(-1)?.init.body)) as Record<string, unknown>
  }
  function replyCreate() {
    replies.push(async () => Response.json({ revision: revisionTwo, sources: [...sources, { ...source, id: lastBody().id }] }, { status: 201 }))
  }
  reply({ revision: revisionOne, sources })
  runInNewContext(script, {
    window: { usageHubHost: bridge, location, history: { replaceState(_data: unknown, _title: string, relative: string) {
      location.href = new URL(relative, location).href
    } } },
    document: { getElementById: control, querySelector: () => ({ content: adminToken }), createElement: () => new Control() },
    async fetch(path: string, init: RequestInit) {
      if (path === '../') { steps.push('wake'); return new Response() }
      if (path === '../api/status') { steps.push('status'); return Response.json(runtime.status()) }
      steps.push(init.method === 'POST' ? 'mutate' : 'list')
      requests.push({ path, init })
      const next = replies.shift()
      if (!next) throw new Error('fixture_response_missing')
      return next()
    },
    AbortSignal, Event, Intl, URL, URLSearchParams, crypto, setTimeout: (callback: () => void) => setTimeout(callback, 0),
  })
  return { control, requests, replies, reply, replyCreate, lastBody, location, bridge, runtime, writes, steps, get saved() { return saved },
    click(id: string) { control(id).dispatchEvent(new Event('click', { cancelable: true })) },
    input(id: string, value: string | boolean) {
      const input = control(id)
      if (typeof value === 'boolean') input.checked = value
      else input.value = value
      input.dispatchEvent(new Event('input'))
    },
    editFirst() { control('sources-rows').children[0].children.at(-1)!.children[0].dispatchEvent(new Event('click')) },
  }
}

describe('source management page', () => {
  test('registers once before enabling reception, reads Options back and confirms the applied listening revision', async () => {
    const ui = harness([], { extensionFlag: true }, '#add')
    await Bun.sleep(0)
    ui.input('source-name', ' 合成来源 ')
    ui.input('source-digest', 'short')
    ui.click('save-source')
    expect(ui.control('source-notice').textContent).toContain('64 位')
    expect(ui.requests).toHaveLength(1)

    ui.input('source-digest', digest.toUpperCase())
    ui.input('receiver-host', '0.0.0.0')
    ui.input('receiver-endpoint', 'https://192.0.2.2/collector/')
    const pending = Promise.withResolvers<Response>()
    ui.replies.push(() => pending.promise)
    ui.click('save-source')
    ui.click('save-source')
    expect(ui.requests).toHaveLength(2)
    expect(ui.requests.at(-1)).toMatchObject({ path: '../api/sources', init: { method: 'POST', credentials: 'omit',
      headers: { 'X-Magpie-Usage-Admin': adminToken, 'Content-Type': 'application/json' },
    } })
    const id = String(ui.lastBody().id)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(ui.lastBody()).toEqual({ revision: revisionOne, action: 'create', id, name: source.name, digest, enabled: true })
    pending.resolve(Response.json({ revision: revisionTwo, sources: [{ ...source, id }] }, { status: 201 }))
    await Bun.sleep(0)
    expect(ui.control('source-digest').value).toBe('')
    expect(ui.control('source-id').textContent).toBe(id)
    expect(ui.control('source-notice').textContent).toBe('来源已登记。')
    expect(ui.control('sources-rows').children[0].children[1].textContent).toBe('等待首次上报')
    expect(ui.saved).toMatchObject({ receiverEnabled: true, role: 'center', enabled: true, collectionMode: 'otlp',
      ingestHost: '0.0.0.0', ingestPort: 3494, publicEndpoint: 'https://192.0.2.2/collector', extensionFlag: true })
    expect(ui.saved).not.toHaveProperty('centerGatewayUrl')
    expect(ui.steps).toEqual(['list', 'get', 'mutate', 'get', 'set', 'get', 'wake', 'status'])
    expect(ui.control('windows-settings').hidden).toBe(false)
    expect(ui.control('windows-endpoint').textContent).toBe('https://192.0.2.2/collector')
    expect(ui.location.hash).toContain(id)
    expect(ui.location.hash).not.toContain(digest)
    expect(ui.control('first-receipt').textContent).toBe('等待首次上报。')

    ui.reply({ revision: revisionTwo, sources: [{ ...source, id, phase: 'receiving', lastPageAt: '2026-11-27T00:00:00.000Z' }] })
    ui.click('refresh-receipt')
    await Bun.sleep(0)
    expect(ui.control('first-receipt').textContent).toMatch(/已收到用量。最近接收 .+。/)
  })

  test('keeps dashboard filters on all configuration links and opens the wizard on demand', async () => {
    const ui = harness([])
    await Bun.sleep(0)
    expect(ui.control('editor').hidden).toBe(true)
    expect(ui.control('back-dashboard').href).toBe('../dashboard/?period=30d&via=conversation')
    expect(ui.control('settings-link').href).toBe('../../../settings.html?back=%3Fperiod%3D30d%26via%3Dconversation')
    expect(ui.control('status-link').href).toBe('../status/?back=%3Fperiod%3D30d%26via%3Dconversation')
    ui.click('add-source')
    await Bun.sleep(0)
    expect(ui.location.hash).toBe('#add')
    expect(ui.control('editor').hidden).toBe(false)
    ui.click('reset-source')
    expect(ui.control('editor').hidden).toBe(true)
  })

  test('checks the sender endpoint and bind port before registering a device', async () => {
    const ui = harness([], {}, '#add')
    await Bun.sleep(0)
    fillDevice(ui)
    for (const invalid of ['http://0.0.0.0:3494', 'http://[::1]', 'http://127.40.5.1', 'http://localhost',
      'http://*:3494', 'http://[::ffff:127.0.0.1]', `${endpoint}/v1/traces`,
      'http://user@192.0.2.2', `${endpoint}/?sample=1`, `${endpoint}/#example`, 'file://192.0.2.2']) {
      ui.input('receiver-endpoint', invalid)
      ui.click('save-source')
      expect(ui.control('receiver-notice').textContent).toContain('设备可达')
    }
    ui.input('receiver-endpoint', endpoint)
    for (const invalid of ['', '3493', '0', '65536']) {
      ui.input('receiver-port', invalid)
      ui.click('save-source')
      expect(ui.control('receiver-notice').textContent).toContain('端口')
    }
    expect(ui.requests).toHaveLength(1)
    expect(ui.writes).toHaveLength(0)
  })

  test('keeps the registered device and receiver draft across an Options save failure and page reload', async () => {
    const ui = harness([], {}, '#add')
    await Bun.sleep(0)
    fillDevice(ui)
    ui.bridge.setOptions = async () => { throw new Error('fixture') }
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('receiver-notice').textContent).toContain('接收设置保存失败')
    expect(ui.control('source-digest').value).toBe('')
    const id = String(ui.lastBody().id)
    const reloaded = harness([{ ...source, id }], {}, ui.location.hash)
    await Bun.sleep(0)
    expect(reloaded.control('source-id').textContent).toBe(id)
    expect(reloaded.control('create-credential').hidden).toBe(true)
    expect(reloaded.control('receiver-endpoint').value).toBe(endpoint)
    reloaded.click('save-source')
    await Bun.sleep(0)
    expect(reloaded.control('windows-settings').hidden).toBe(false)
    expect(reloaded.requests).toHaveLength(1)
    expect(reloaded.writes).toHaveLength(1)
  })

  test('recovers a lost creation receipt by exact id despite a source with the same name', async () => {
    const ui = harness([source], {}, '#add')
    await Bun.sleep(0)
    fillDevice(ui, false)
    const response = Promise.withResolvers<Response>()
    ui.replies.push(() => response.promise)
    ui.click('save-source')
    const id = String(ui.lastBody().id)
    const fragment = ui.location.hash
    expect(fragment).toContain('stage=register')
    expect(fragment).not.toContain(digest)
    expect(fragment).not.toContain(encodeURIComponent(source.name))
    ui.reply({ revision: revisionTwo, sources: [source, { ...source, id }] })
    response.reject(new Error('lost receipt'))
    await Bun.sleep(0)
    expect(ui.control('source-id').textContent).toBe(id)
    expect(ui.control('create-credential').hidden).toBe(true)
    expect(ui.control('source-notice').textContent).toContain('已确认原设备登记成功')
    expect(ui.writes).toHaveLength(0)
    expect(ui.requests.map(request => request.init.method)).toEqual(['GET', 'POST', 'GET'])

    const reloaded = harness([source, { ...source, id }], {}, fragment)
    await Bun.sleep(0)
    expect(reloaded.control('source-id').textContent).toBe(id)
    expect(reloaded.control('receiver-endpoint').value).toBe(endpoint)
    reloaded.click('save-source')
    await Bun.sleep(0)
    expect(reloaded.requests.map(request => request.init.method)).toEqual(['GET'])
    expect(reloaded.control('windows-settings').hidden).toBe(false)
  })

  test('requires explicit retry with the same id after a lost response without a confirmed registration', async () => {
    const ui = harness([source], {}, '#add')
    await Bun.sleep(0)
    fillDevice(ui, false)
    const response = Promise.withResolvers<Response>()
    ui.replies.push(() => response.promise)
    ui.click('save-source')
    const id = String(ui.lastBody().id)
    ui.reply({ revision: revisionOne, sources: [source] })
    response.reject(new Error('lost response'))
    await Bun.sleep(0)
    expect(ui.control('source-id').textContent).toBe('')
    expect(ui.control('source-notice').textContent).toContain('尚未查到此次登记')
    expect(ui.control('source-digest').value).toBe(digest)
    expect(ui.control('save-source').disabled).toBe(true)
    expect(ui.requests.map(request => request.init.method)).toEqual(['GET', 'POST', 'GET'])
    ui.click('review-latest')
    ui.replyCreate()
    ui.click('save-source')
    expect(ui.lastBody().id).toBe(id)
    await Bun.sleep(0)
    expect(ui.control('source-id').textContent).toBe(id)
    expect(ui.writes).toHaveLength(1)
  })

  test('reenters an expired management session with the dashboard filters and recoverable device draft', async () => {
    const ui = harness([], {}, '#add')
    await Bun.sleep(0)
    fillDevice(ui, false)
    ui.reply({ error: { code: 'admin_token_invalid' } }, 403)
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('management-reentry').hidden).toBe(false)
    const target = new URL(ui.control('resume-management').href, ui.location.href)
    expect(target.pathname).toBe('/plugin/_magpie/service/')
    expect(target.searchParams.get('to')).toBe('sources')
    expect(target.searchParams.get('back')).toBe('?period=30d&via=conversation')
    expect(target.hash).toContain(`add=${String(ui.lastBody().id)}`)
    expect(target.href).not.toContain(digest)
    expect(target.href).not.toContain(adminToken)
  })

  test('adopts an intervening Options revision explicitly while preserving the registered device and edits', async () => {
    const ui = harness([], { configRevision: revisionOne }, '#add')
    await Bun.sleep(0)
    fillDevice(ui)
    const read = ui.bridge.getOptions
    let changed = true
    ui.bridge.getOptions = async () => changed ? { configRevision: revisionTwo, timeZone: 'UTC' } : read()
    const write = ui.bridge.setOptions
    ui.bridge.setOptions = async next => { changed = false; await write(next) }
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('review-receiver').hidden).toBe(false)
    expect(ui.control('save-source').disabled).toBe(true)
    expect(ui.writes).toHaveLength(0)
    ui.click('review-receiver')
    expect(ui.control('receiver-endpoint').value).toBe(endpoint)
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('windows-settings').hidden).toBe(false)
    expect(ui.saved.timeZone).toBe('UTC')
    expect(ui.requests.filter(request => request.init.method === 'POST')).toHaveLength(1)
    expect(ui.writes).toHaveLength(1)
  })

  test('recovers after a failed bind using the same device and checks the new listening revision', async () => {
    const ui = harness([], {}, '#add')
    await Bun.sleep(0)
    fillDevice(ui)
    const ready = ui.runtime.status
    ui.runtime.status = () => ({ ...ready(), appliedRevision: null, receiver: 'failed' })
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('receiver-notice').textContent).toContain('监听失败')
    expect(ui.control('windows-settings').hidden).toBe(true)
    const firstRevision = ui.saved.configRevision
    ui.input('receiver-port', '3504')
    ui.input('receiver-endpoint', 'http://192.0.2.2:3504')
    ui.runtime.status = ready
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('windows-settings').hidden).toBe(false)
    expect(ui.saved.configRevision).not.toBe(firstRevision)
    expect(ui.saved.ingestPort).toBe(3504)
    expect(ui.requests.filter(request => request.init.method === 'POST')).toHaveLength(1)
  })

  test('recovers an unconfirmed receiver write with a read and verifies adoption before showing Windows values', async () => {
    const ui = harness([], {}, '#add')
    await Bun.sleep(0)
    fillDevice(ui)
    const read = ui.bridge.getOptions
    let failReadback = true
    ui.bridge.getOptions = () => ui.writes.length && failReadback ? Promise.reject(new Error('fixture')) : read()
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('reload-receiver').hidden).toBe(false)
    expect(ui.control('save-source').disabled).toBe(true)
    expect(ui.control('receiver-notice').textContent).toContain('保存结果待确认')
    expect(ui.control('windows-settings').hidden).toBe(true)
    failReadback = false
    ui.click('reload-receiver')
    await Bun.sleep(0)
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('windows-settings').hidden).toBe(false)
    expect(ui.writes).toHaveLength(1)
    expect(ui.requests).toHaveLength(2)
  })

  test('retains the endpoint draft when the Options readback differs from the write', async () => {
    const ui = harness([], {}, '#add')
    await Bun.sleep(0)
    fillDevice(ui)
    const write = ui.bridge.setOptions
    ui.bridge.setOptions = next => write({ ...next, publicEndpoint: 'https://other.example' })
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('receiver-notice').textContent).toContain('读回值')
    expect(ui.control('windows-settings').hidden).toBe(true)
    expect(ui.control('receiver-endpoint').value).toBe(endpoint)
    expect(ui.control('review-receiver').hidden).toBe(false)
    expect(ui.steps).not.toContain('wake')
    ui.click('review-receiver')
    ui.bridge.setOptions = write
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('windows-settings').hidden).toBe(false)
    expect(ui.requests).toHaveLength(2)
  })

  test('reuses an existing receiver from the source editor and waits for the matching runtime revision', async () => {
    const saved = { enabled: true, role: 'center', collectionMode: 'otlp', ingestHost: '0.0.0.0', ingestPort: 3494,
      publicEndpoint: endpoint, receiverEnabled: true, configRevision: revisionTwo }
    const ui = harness([source], saved)
    await Bun.sleep(0)
    ui.editFirst()
    ui.click('resume-source')
    await Bun.sleep(0)
    expect(ui.control('receiver-fields').hidden).toBe(true)
    expect(ui.control('saved-receiver').textContent).toContain(endpoint)
    const ready = ui.runtime.status
    ui.runtime.status = () => ({ ...ready(), appliedRevision: revisionOne })
    ui.click('save-source')
    for (let attempt = 0; attempt < 100 && !ui.control('receiver-notice').textContent.includes('尚未确认'); attempt++) await Bun.sleep(2)
    expect(ui.control('receiver-notice').textContent).toContain('尚未确认')
    expect(ui.control('windows-settings').hidden).toBe(true)
    ui.runtime.status = ready
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('windows-settings').hidden).toBe(false)
    expect(ui.writes).toHaveLength(0)
    expect(ui.requests).toHaveLength(1)
  })

  test('registers a second device while reusing the adopted listener', async () => {
    const saved = { enabled: true, role: 'center', collectionMode: 'otlp', ingestHost: '0.0.0.0', ingestPort: 3494,
      publicEndpoint: endpoint, receiverEnabled: true, configRevision: revisionTwo }
    const ui = harness([source], saved)
    await Bun.sleep(0)
    ui.click('add-source')
    await Bun.sleep(0)
    expect(ui.control('receiver-fields').hidden).toBe(true)
    ui.input('source-name', '第二台合成设备')
    ui.input('source-digest', 'c'.repeat(64))
    ui.replyCreate()
    ui.click('save-source')
    const id = String(ui.lastBody().id)
    await Bun.sleep(0)
    expect(id).not.toBe(source.id)
    expect(ui.control('source-id').textContent).toBe(id)
    expect(ui.control('windows-settings').hidden).toBe(false)
    expect(ui.control('windows-endpoint').textContent).toBe(endpoint)
    expect(ui.control('sources-rows').children).toHaveLength(2)
    expect(ui.writes).toHaveLength(0)
  })

  test('preserves a 0.7 listener when adding its Windows-reachable address', async () => {
    const ui = harness([], { enabled: true, role: 'center', collectionMode: 'otlp', ingestHost: '192.0.2.2',
      ingestPort: 4242, configRevision: revisionOne }, '#add')
    await Bun.sleep(0)
    expect(ui.control('receiver-fields').hidden).toBe(false)
    expect(ui.control('receiver-port').value).toBe('4242')
    ui.input('source-name', source.name)
    ui.input('source-digest', digest)
    ui.input('receiver-endpoint', 'https://hub.example/collector')
    ui.replyCreate()
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.saved).toMatchObject({ ingestHost: '192.0.2.2', ingestPort: 4242, publicEndpoint: 'https://hub.example/collector' })
    expect(ui.control('windows-settings').hidden).toBe(false)
  })

  test('preserves edited fields across a conflicting source revision', async () => {
    const ui = harness()
    await Bun.sleep(0)
    ui.editFirst()
    ui.input('source-name', '本地草稿')
    ui.reply({ error: { code: 'source_revision_conflict' } }, 409)
    ui.reply({ revision: revisionTwo, sources: [{ ...source, enabled: false }] })
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('source-name').value).toBe('本地草稿')
    expect(ui.control('revision-review').hidden).toBe(false)
    expect(ui.control('save-source').disabled).toBe(true)
    ui.click('review-latest')
    expect(ui.control('source-name').value).toBe('本地草稿')
    expect(ui.control('source-enabled').checked).toBe(false)
    expect(ui.control('save-source').disabled).toBe(false)
    ui.reply({ revision: revisionThree, sources: [{ ...source, name: '本地草稿', enabled: false }] })
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.lastBody()).toEqual({ id: source.id, revision: revisionTwo, action: 'update', name: '本地草稿' })
    expect(ui.control('source-notice').textContent).toBe('来源已保存。')
  })

  test('retains a pause draft after an unsuccessful write and sends the same update on retry', async () => {
    const ui = harness()
    await Bun.sleep(0)
    ui.editFirst()
    ui.input('source-enabled', false)
    ui.reply({ error: { code: 'source_save_failed' } }, 503)
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.lastBody()).toEqual({ id: source.id, revision: revisionOne, action: 'update', enabled: false })
    expect(ui.control('source-enabled').checked).toBe(false)
    expect(ui.control('source-notice').textContent).toContain('可重试')
    ui.reply({ revision: revisionTwo, sources: [{ ...source, enabled: false, phase: 'paused' }] })
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('sources-rows').children[0].children[1].textContent).toBe('已暂停')
    expect(ui.control('source-notice').textContent).toBe('来源已保存。')
  })

  test('checks pending credential verification before confirming revocation', async () => {
    const ui = harness()
    await Bun.sleep(0)
    ui.editFirst()
    ui.input('rotation-digest', digest)
    const pending = { ...source, credentials: { current: true, pending: true, pendingVerified: false } }
    ui.reply({ revision: revisionTwo, sources: [pending] })
    ui.click('rotate-source')
    await Bun.sleep(0)
    expect(ui.lastBody()).toEqual({ id: source.id, revision: revisionOne, action: 'rotate', digest })
    expect(ui.control('rotation-digest').value).toBe('')
    expect(ui.control('revoke-current').disabled).toBe(true)
    ui.click('revoke-current')
    expect(ui.control('action-confirmation').hidden).toBe(true)

    ui.reply({ revision: revisionTwo, sources: [{ ...pending, credentials: { ...pending.credentials, pendingVerified: true } }] })
    ui.click('refresh-sources')
    await Bun.sleep(0)
    expect(ui.control('revoke-current').disabled).toBe(false)
    ui.click('revoke-current')
    expect(ui.requests).toHaveLength(3)
    expect(ui.control('confirmation-text').textContent).toContain('待用令牌将接替当前令牌')
    ui.reply({ revision: revisionThree, sources: [source] })
    ui.click('confirm-action')
    await Bun.sleep(0)
    expect(ui.lastBody()).toEqual({ id: source.id, revision: revisionTwo, action: 'revoke', slot: 'current' })
    expect(ui.control('revoke-pending').hidden).toBe(true)
  })

  test('allows same-source recovery for the center gateway after explicit confirmation', async () => {
    const blocked = { ...source, id: 'local', transport: 'local', phase: 'recovery_required',
      recoveryReason: 'cursor_reset', rebuildAllowed: true,
    }
    const ui = harness([blocked])
    await Bun.sleep(0)
    ui.editFirst()
    expect(ui.control('recovery-tools').hidden).toBe(false)
    ui.click('rebuild-source')
    expect(ui.control('confirmation-text').textContent).toContain('仍是原来源')
    ui.click('cancel-action')
    expect(ui.control('action-confirmation').hidden).toBe(true)
    expect(ui.requests).toHaveLength(1)
    ui.click('rebuild-source')
    ui.reply({ revision: revisionTwo, sources: [{ ...blocked, phase: 'rebuilding', rebuildAllowed: false }] })
    ui.click('confirm-action')
    await Bun.sleep(0)
    expect(ui.lastBody()).toEqual({ id: 'local', revision: revisionOne, action: 'rebuild' })
    expect(ui.control('source-notice').textContent).toContain('已确认重建')
    expect(ui.control('recovery-tools').hidden).toBe(true)
  })

  test('keeps historical sources viewable and displays accepted OTLP activity during idle periods', async () => {
    const historical = { ...source, name: '历史账本', transport: 'legacy', phase: 'historical', rebuildAllowed: true }
    const oldReceipt = '2026-01-01T07:00:00.000Z'
    const receiving = { ...source, id: 'ae55d102-304a-45a0-ad84-65d85ea5b227', phase: 'receiving',
      lastSeenAt: oldReceipt, lastPageAt: oldReceipt,
    }
    const ui = harness([historical, receiving])
    await Bun.sleep(0)
    const [history, live] = ui.control('sources-rows').children
    expect(history.children[1].textContent).toBe('历史来源')
    expect(live.children[1].textContent).toBe('已收到用量')
    expect(live.children[2].textContent).toContain('最近接收')
    ui.editFirst()
    expect(ui.control('historical-source-hint').hidden).toBe(false)
    expect(ui.control('source-form').hidden).toBe(true)
    expect(ui.control('source-credentials').hidden).toBe(true)
    expect(ui.control('recovery-tools').hidden).toBe(true)
    ui.click('save-source')
    ui.click('rebuild-source')
    expect(ui.requests).toHaveLength(1)
  })
})
