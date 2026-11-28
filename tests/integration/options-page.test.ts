import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

type Options = Record<string, unknown>
type ViewState = {
  result: string
  saved: Options | null
  writing: boolean
  refreshing: boolean
  pending: boolean
  differences?: string[]
}
type PageOptions = {
  revision(value: unknown): string
  createId(): string
  dashboardSearch(raw: unknown): string
  receiverFragment(raw: unknown): string
  pageServiceLink(service: unknown, current: string, saved?: Options): string
  settingsView(saved: Options): Options
  settingsPatch(draft: Options): Options
  createSession(
    bridge: { get(): Promise<unknown>; set(value: Options): Promise<void> },
    publish: (state: ViewState) => void,
  ): {
    refresh(): Promise<void>
    submit(patch: Options): Promise<void>
    adoptLatest(): void
  }
}

const source = readFileSync(new URL('../../page/options.js', import.meta.url), 'utf8')
const page = runInNewContext(`${source}\nusageHubOptions`, { crypto, URL, URLSearchParams, Intl }) as PageOptions
const revisionOne = '11111111-1111-4111-8111-111111111111'
const settings = { enabled: true, centerGatewayUrl: 'http://127.0.0.1:3425/',
  ingestHost: '127.0.0.1', ingestPort: 3494, timeZone: 'Asia/Shanghai', requestTimeoutSec: 30,
}
const original = { ...settings, collectionMode: 'otlp', role: 'center', configRevision: revisionOne }
const configuration = readFileSync(new URL('../../page/configuration.js', import.meta.url), 'utf8')

async function settingsPage() {
  class Control extends EventTarget {
    checked = false
    disabled = false
    hidden = false
    href = ''
    value = ''
    textContent = ''
    attributes = new Map<string, string>()
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value) }
    setAttribute(name: string, value: string) { this.attributes.set(name, value) }
    removeAttribute(name: string) { this.attributes.delete(name) }
    replaceChildren() {}
    toggleAttribute() {}
  }
  const controls = new Map<string, Control>()
  function control(id: string) {
    if (!controls.has(id)) controls.set(id, new Control())
    return controls.get(id)!
  }
  let stored: Options = { ...original }
  const writes: Options[] = []
  const writeTimes: number[] = []
  let beforeWrite: (() => Promise<unknown>) | undefined
  let beforeRead: (() => Promise<unknown>) | undefined
  const navigations: string[] = []
  const service = 'https://usage.example.com/plugins/fixture/_magpie/service/'
  const back = new URLSearchParams({ back: '?view=details&period=30d&sourceId=local&model=&token=fixture' })
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  let clock = 0
  runInNewContext(configuration, {
    usageHubOptions: page,
    document: { getElementById: control, createElement: () => new Control() },
    window: {
      location: { href: `https://usage.example.com/plugins/fixture/settings.html?${back}`, assign: (url: string) => navigations.push(url) },
      magpie: { service, options: {
        async get() { await beforeRead?.(); return { ...stored } },
        async set(next: Options) { writes.push(next); writeTimes.push(clock); await beforeWrite?.(); stored = next },
      } },
    },
    Event, URL, performance: { now: () => clock },
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimer
      if (delay === 1500) timers.set(id, callback)
      if (delay <= 1000) queueMicrotask(() => { clock += delay; callback() })
      return id
    },
    clearTimeout(id: number) { timers.delete(id) },
  })
  await Bun.sleep(0)
  return {
    control, writes, writeTimes, navigations,
    get stored() { return stored },
    update(next: Options) { stored = { ...stored, ...next } },
    onWrite(handler?: () => Promise<unknown>) { beforeWrite = handler },
    onRead(handler?: () => Promise<unknown>) { beforeRead = handler },
    expireToast() { for (const callback of timers.values()) callback(); timers.clear() },
    edit(id: string, value: string, commit = true) {
      control(id).value = value
      control(id).dispatchEvent(new Event('input'))
      if (commit) control(id).dispatchEvent(new Event('change'))
    },
  }
}

function harness(initial: Options = original) {
  let stored: Options = { ...initial }
  let readNext: (() => Promise<unknown>) | undefined
  let rejectWrite = false
  let afterWrite: (() => void) | undefined
  const writes: Options[] = []
  const views: ViewState[] = []
  const session = page.createSession({
    async get() {
      const next = readNext
      readNext = undefined
      return next ? next() : { ...stored }
    },
    async set(value) {
      writes.push(value)
      if (rejectWrite) throw new Error('synthetic write error')
      stored = value
      afterWrite?.()
    },
  }, view => views.push(view))
  return {
    ...session,
    writes,
    get last() { return views.at(-1)! },
    update(next: Options) { stored = { ...stored, ...next } },
    nextRead(read: () => Promise<unknown>) { readNext = read },
    failWrite() { rejectWrite = true },
    afterWrite(run: () => void) { afterWrite = run },
  }
}

describe('plugin Options page', () => {
  test('defaults to local collection and validates its gateway, listener and sender endpoint', () => {
    const defaults = { ...settings, centerGatewayUrl: '', receiverEnabled: false, publicEndpoint: '', ingestPort: '3494', requestTimeoutSec: '30' }
    expect(page.settingsView({})).toEqual(defaults)
    expect(page.settingsView({ collectionMode: 'pull', role: 'center', enabled: true })).toMatchObject({ enabled: false, receiverEnabled: false })
    expect(page.settingsView(original)).toEqual({ ...defaults, centerGatewayUrl: settings.centerGatewayUrl, receiverEnabled: true })
    const draft = { ...settings, centerGatewayUrl: 'http://[::1]:3425', ingestHost: '::', requestTimeoutSec: 60 }
    expect(page.settingsPatch(draft)).toEqual({ ...draft, collectionMode: 'otlp', role: 'center', centerGatewayUrl: 'http://[::1]:3425/', receiverEnabled: false, publicEndpoint: '' })
    expect(page.settingsPatch({ ...draft, centerGatewayUrl: '' }).centerGatewayUrl).toBeUndefined()
    for (const publicEndpoint of ['file://fixture', 'http://[::1]', 'http://127.1', 'http://0.0.0.0', 'http://user@fixture/', 'https://example.org/?x=1']) {
      expect(() => page.settingsPatch({ ...draft, publicEndpoint })).toThrow(/基础地址/)
    }
    expect(page.settingsPatch({ ...draft, publicEndpoint: 'https://collector.example.org/otlp/' }).publicEndpoint).toBe('https://collector.example.org/otlp')
    for (const url of ['https://other.example/', 'http://127.0.0.1/?', 'http://127.0.0.1/#',
      'http://127.0.0.1/anything/..', 'http://@127.0.0.1', 'ftp://127.0.0.1/']) {
      expect(() => page.settingsPatch({ ...draft, centerGatewayUrl: url })).toThrow(/回环网关根地址/)
    }
    for (const timeout of [0, 121, Number.NaN, 1.5]) {
      expect(() => page.settingsPatch({ ...draft, requestTimeoutSec: timeout })).toThrow(/1 至 120/)
    }
    for (const ingestPort of [3425, 3493]) expect(() => page.settingsPatch({ ...draft, ingestPort })).toThrow(/冲突/)
    expect(() => page.settingsPatch({ ...draft, ingestHost: '256.1.1.1' })).toThrow(/监听/)
    expect(() => page.settingsPatch({ ...draft, timeZone: 'Fixture/Unknown' })).toThrow(/时区/)
  })

  test('uses saved center values on upgrade and confirms an OTLP settings write', async () => {
    const legacyCenter = { ...original, collectionMode: 'push', centerGatewayUrl: 'http://127.0.0.1:3567/',
      ingestHost: '0.0.0.0', ingestPort: 4318, timeZone: 'UTC', requestTimeoutSec: 10,
    }
    const view = page.settingsView(legacyCenter)
    expect(view).toEqual({ ...settings, receiverEnabled: true, publicEndpoint: '', centerGatewayUrl: legacyCenter.centerGatewayUrl,
      ingestHost: '0.0.0.0', ingestPort: '4318', timeZone: 'UTC', requestTimeoutSec: '10',
    })
    const patch = page.settingsPatch({ ...view, ingestPort: 4318, requestTimeoutSec: 10 })
    const ui = harness(legacyCenter)
    await ui.refresh()
    await ui.submit(patch)
    expect(ui.last).toMatchObject({ result: 'confirmed', saved: { ...patch, collectionMode: 'otlp' } })
    expect(page.settingsView(ui.last.saved!)).toEqual(view)
  })

  test('opens the service root before navigating to the requested dashboard', () => {
    const base = 'https://usage.example.com/plugins/synthetic-token/'
    const service = `${base}_magpie/service/`
    const pageUrl = `${base}index.html`
    expect(page.pageServiceLink(service, pageUrl, original)).toBe(`${service}#revision=${revisionOne}&view=dashboard`)
    expect(page.pageServiceLink(service, pageUrl, { enabled: true })).toBe(service)
    expect(page.pageServiceLink(service, pageUrl, { ...original, enabled: false })).toBe(`${service}#revision=${revisionOne}`)
    const legacySender = { ...original, collectionMode: 'push', role: 'sender', reportKeyFile: '/fixture/key.txt' }
    expect(page.pageServiceLink(service, pageUrl, legacySender)).toBe(`${service}#revision=${revisionOne}`)
    expect(page.settingsView(legacySender)).toEqual(page.settingsView({ ...original, enabled: false }))
    expect(page.pageServiceLink('', pageUrl, original)).toBe('')
    expect(page.pageServiceLink(service, 'https://elsewhere.example/', original)).toBe('')
    expect(page.pageServiceLink(`${service}?unknown=value#untrusted`, pageUrl, original)).toBe(`${service}#revision=${revisionOne}&view=dashboard`)
    expect(page.pageServiceLink('https://user@usage.example.com/plugins/fixture/_magpie/service/', pageUrl, original)).toBe('')
  })

  test('preserves every supported dashboard selection and accepts only a valid ordered custom range', () => {
    const filters = { period: 'custom', from: '2026-11-26T08:00:00+08:00', to: '2026-11-27T00:00:00Z',
      via: 'conversation', view: 'details', sourceId: revisionOne, model: '', metric: 'cost', bucket: 'hour',
      detailFrom: '2026-11-26T08:00:00+08:00', detailTo: '2026-11-26T09:00:00+08:00' }
    const raw = new URLSearchParams({ ...filters, token: 'fixture', after: 'fixture', layout: 'table' })
    expect(Object.fromEntries(new URLSearchParams(page.dashboardSearch(String(raw))))).toEqual(filters)
    expect(page.dashboardSearch('?period=today&sourceId=local&model=vendor%2Fgpt')).toBe('?period=today&sourceId=local&model=vendor%2Fgpt')
    for (const from of ['2026-02-30T00:00:00Z', '2026-11-28T00:00:00Z', '2026-11-26T00:00:00', '2026-11-26T00:00:00.00001Z']) {
      const invalid = new URLSearchParams({ ...filters, from })
      expect(new URLSearchParams(page.dashboardSearch(String(invalid))).has('period')).toBe(false)
    }
    expect(page.dashboardSearch('?view=config&via=unknown&layout=mobile&metric=usd&sourceId=token&model=%00')).toBe('')
    expect(page.dashboardSearch(`?model=${'m'.repeat(513)}`)).toBe('')
    expect(new URLSearchParams(page.dashboardSearch(String(new URLSearchParams({ ...filters, view: 'overview' })))).has('detailFrom')).toBe(false)
  })

  test('keeps the device recovery ID and only validated listener and endpoint fields', () => {
    const params = new URLSearchParams({ add: revisionOne, stage: 'register', retry: 'bind', ip: '0.0.0.0',
      port: '3494', endpoint: 'https://hub.example/otlp/', revision: 'initial', digest: 'fixture' })
    expect(Object.fromEntries(new URLSearchParams(page.receiverFragment(`#${params}`).slice(1)))).toEqual({
      add: revisionOne, stage: 'register', retry: 'bind', ip: '0.0.0.0', port: '3494', endpoint: 'https://hub.example/otlp', revision: 'initial',
    })
    expect(page.receiverFragment('#add&digest=fixture')).toBe('#add')
    expect(page.receiverFragment('#add=other&stage=register')).toBe('')
    expect(page.receiverFragment(`#add=${revisionOne}&port=3494%0A&ip=1.2.3.4%0A&endpoint=https%3A%2F%2Ffixture%40hub.example%2F&revision=fixture`)).toBe(`#add=${revisionOne}`)
  })

  test('merges retained settings and can enable or stop the service through confirmed readbacks', async () => {
    const legacy = { enabled: true, role: 'center', ingestKeyFile: '/fixture/old-key.json', configRevision: revisionOne }
    const ui = harness(legacy)
    await ui.refresh()
    ui.update({ customUse: { enabled: true } })
    for (const enabled of [true, false]) {
      const draft = { ...settings, enabled, requestTimeoutSec: 45 }
      const patch = page.settingsPatch(draft)
      await ui.submit(patch)
      const savedRevision = ui.last.saved?.configRevision
      expect(ui.last).toMatchObject({ result: 'confirmed',
        saved: { ...legacy, ...patch, customUse: { enabled: true }, configRevision: savedRevision },
      })
      expect(page.revision(savedRevision)).toBe(String(savedRevision))
      expect(savedRevision).not.toBe(revisionOne)
    }
  })

  test('retains a center address draft when another window changes the timeout', async () => {
    const ui = await settingsPage()
    const { control } = ui
    for (const [id, tab] of [['return-dashboard', 'dashboard'], ['sources-link', 'sources'], ['diagnostic-link', 'status']]) {
      const url = new URL(control(id).href)
      expect(url.searchParams.get('to')).toBe(tab)
      expect(url.searchParams.get('back')).toBe('?view=details&period=30d&sourceId=local&model=')
    }
    ui.update({ requestTimeoutSec: 60, configRevision: page.createId() })
    ui.edit('centerGatewayUrl', 'http://127.0.0.1:3456/')
    await Bun.sleep(0)
    expect(control('rebase-options').hidden).toBe(false)
    expect(ui.stored.centerGatewayUrl).toBe(original.centerGatewayUrl)
    expect(control('settings-saved').textContent).toBe('')
    control('rebase-options').dispatchEvent(new Event('click'))
    expect(control('centerGatewayUrl').value).toBe('http://127.0.0.1:3456/')
    expect(control('requestTimeoutSec').value).toBe('60')
    control('retry-save').dispatchEvent(new Event('click'))
    await Bun.sleep(0)
    expect(ui.stored).toMatchObject({ centerGatewayUrl: 'http://127.0.0.1:3456/', requestTimeoutSec: 60 })
    ui.edit('centerGatewayUrl', '')
    await Bun.sleep(0)
    expect(ui.stored.centerGatewayUrl).toBeUndefined()
  })

  test('commits validated edits in order and keeps later typing out of a queued write', async () => {
    const ui = await settingsPage()
    const { control } = ui
    const gate = Promise.withResolvers<void>()
    ui.edit('requestTimeoutSec', '')
    expect(control('requestTimeoutSec').attributes.get('aria-invalid')).toBe('true')
    expect(ui.writes).toHaveLength(0)
    ui.onWrite(() => gate.promise)
    ui.edit('requestTimeoutSec', '31', false)
    await Bun.sleep(0)
    expect(ui.writes).toHaveLength(0)
    control('requestTimeoutSec').dispatchEvent(new Event('change'))
    await Bun.sleep(0)
    ui.edit('timeZone', 'UTC')
    ui.edit('timeZone', 'Asia/Tokyo', false)
    expect(control('revision-value').textContent).toBe(revisionOne)
    expect(control('settings-saved').textContent).toBe('')
    expect(ui.writes).toHaveLength(1)
    gate.resolve()
    await Bun.sleep(0)
    expect(ui.writes).toHaveLength(2)
    expect(ui.stored).toMatchObject({ requestTimeoutSec: 31, timeZone: 'UTC' })
    expect(control('timeZone').value).toBe('Asia/Tokyo')
    control('timeZone').dispatchEvent(new Event('change'))
    control('timeZone').dispatchEvent(new Event('change'))
    const navigate = new Event('click', { cancelable: true })
    control('diagnostic-link').dispatchEvent(navigate)
    expect(navigate.defaultPrevented).toBe(true)
    expect(ui.navigations).toHaveLength(0)
    await Bun.sleep(0)
    expect(ui.writes).toHaveLength(3)
    expect(ui.writeTimes).toEqual([0, 1000, 2000])
    expect(ui.stored.timeZone).toBe('Asia/Tokyo')
    expect(control('revision-value').textContent).toBe(ui.stored.configRevision as string)
    expect(control('settings-message').textContent).toBe('')
    expect(control('settings-saved').textContent).toBe('已保存')
    expect(ui.navigations).toEqual([control('diagnostic-link').href])
    expect(ui.navigations[0]).toContain(`revision=${ui.stored.configRevision}`)
    ui.expireToast()
    expect(control('settings-saved').textContent).toBe('')
  })

  test('keeps failed drafts and only confirms a revision after a successful readback', async () => {
    const ui = await settingsPage()
    const { control } = ui
    ui.onWrite(async () => { throw new Error('fixture write failure') })
    ui.edit('requestTimeoutSec', '31')
    await Bun.sleep(0)
    expect(control('retry-save').hidden).toBe(false)
    expect(control('requestTimeoutSec').value).toBe('31')
    expect(control('settings-saved').textContent).toBe('')
    ui.onWrite(async () => ui.onRead(async () => { throw new Error('fixture readback failure') }))
    control('retry-save').dispatchEvent(new Event('click'))
    await Bun.sleep(0)
    expect(control('reload-options').hidden).toBe(false)
    expect(control('revision-value').textContent).toBe(revisionOne)
    expect(control('settings-saved').textContent).toBe('')
    ui.onRead()
    control('reload-options').dispatchEvent(new Event('click'))
    await Bun.sleep(0)
    expect(ui.writes).toHaveLength(2)
    expect(control('revision-value').textContent).toBe(ui.stored.configRevision as string)
    expect(control('settings-saved').textContent).toBe('已保存')
  })

  test('retains the saved view after write rejection and mismatched readback', async () => {
    const rejected = harness()
    await rejected.refresh()
    rejected.failWrite()
    await rejected.submit({ requestTimeoutSec: 20 })
    expect(rejected.last).toMatchObject({ result: 'write_failed', saved: original, writing: false, pending: false })

    const different = harness()
    await different.refresh()
    different.afterWrite(() => different.update({ requestTimeoutSec: 40 }))
    await different.submit({ requestTimeoutSec: 20 })
    expect(different.last).toMatchObject({ result: 'readback_mismatch', saved: original, differences: ['本机网关请求超时'] })
  })

  test('retries a failed readback with a single write', async () => {
    const ui = harness()
    await ui.refresh()
    ui.afterWrite(() => ui.nextRead(async () => { throw new Error('synthetic readback error') }))
    await ui.submit({ requestTimeoutSec: 20 })
    expect(ui.last).toMatchObject({ result: 'readback_failed', saved: original, pending: true })
    await ui.submit({ requestTimeoutSec: 20 })
    await ui.refresh()
    expect(ui.last).toMatchObject({ result: 'confirmed', saved: { requestTimeoutSec: 20 }, pending: false })
    expect(ui.writes).toHaveLength(1)
  })

  test('keeps a newer Options read busy after an earlier response completes', async () => {
    const ui = harness()
    const old = Promise.withResolvers<Options>()
    const latest = Promise.withResolvers<Options>()
    ui.nextRead(() => old.promise)
    const older = ui.refresh()
    ui.nextRead(() => latest.promise)
    const newer = ui.refresh()
    old.resolve({ enabled: false })
    await older
    expect(ui.last).toMatchObject({ result: 'loading', saved: null, refreshing: true })
    latest.resolve(original)
    await newer
    expect(ui.last).toMatchObject({ result: 'loaded', saved: original, refreshing: false })
  })
})
