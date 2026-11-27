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
      via: 'conversation', view: 'details', sourceId: revisionOne, model: '', metric: 'cost', layout: 'table' }
    const raw = new URLSearchParams({ ...filters, token: 'fixture', after: 'fixture' })
    expect(Object.fromEntries(new URLSearchParams(page.dashboardSearch(String(raw))))).toEqual(filters)
    expect(page.dashboardSearch('?period=today&sourceId=local&model=vendor%2Fgpt')).toBe('?period=today&sourceId=local&model=vendor%2Fgpt')
    for (const from of ['2026-02-30T00:00:00Z', '2026-11-28T00:00:00Z', '2026-11-26T00:00:00', '2026-11-26T00:00:00.00001Z']) {
      const invalid = new URLSearchParams({ ...filters, from })
      expect(new URLSearchParams(page.dashboardSearch(String(invalid))).has('period')).toBe(false)
    }
    expect(page.dashboardSearch('?view=config&via=unknown&layout=mobile&metric=usd&sourceId=token&model=%00')).toBe('')
    expect(page.dashboardSearch(`?model=${'m'.repeat(513)}`)).toBe('')
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
    class Control extends EventTarget {
      checked = false
      disabled = false
      hidden = false
      href = ''
      value = ''
      textContent = ''
      get valueAsNumber() { return Number(this.value) }
      setAttribute() {}
      removeAttribute() {}
      replaceChildren() {}
      toggleAttribute() {}
    }
    const controls = new Map<string, Control>()
    function control(id: string) {
      if (!controls.has(id)) controls.set(id, new Control())
      return controls.get(id)!
    }
    let stored: Options = { ...original }
    const service = 'https://usage.example.com/plugins/fixture/_magpie/service/'
    const back = new URLSearchParams({ back: '?view=details&period=30d&sourceId=local&model=&token=fixture' })
    runInNewContext(await Bun.file(new URL('../../page/configuration.js', import.meta.url)).text(), {
      usageHubOptions: page,
      document: { getElementById: control, createElement: () => new Control() },
      window: { location: { href: `https://usage.example.com/plugins/fixture/settings.html?${back}` },
        magpie: { service, options: { async get() { return { ...stored } }, async set(next: Options) { stored = next } } },
      },
      Event, setTimeout, clearTimeout, URL,
    })
    await Bun.sleep(0)
    for (const [id, tab] of [['return-dashboard', 'dashboard'], ['sources-link', 'sources'], ['diagnostic-link', 'status']]) {
      const url = new URL(control(id).href)
      expect(url.searchParams.get('to')).toBe(tab)
      expect(url.searchParams.get('back')).toBe('?view=details&period=30d&sourceId=local&model=')
    }
    control('centerGatewayUrl').value = 'http://127.0.0.1:3456/'
    control('centerGatewayUrl').dispatchEvent(new Event('input'))
    stored = { ...stored, requestTimeoutSec: 60, configRevision: page.createId() }
    control('save-settings').dispatchEvent(new Event('click', { cancelable: true }))
    await Bun.sleep(0)
    expect(control('rebase-options').hidden).toBe(false)
    expect(stored.centerGatewayUrl).toBe(original.centerGatewayUrl)
    control('rebase-options').dispatchEvent(new Event('click'))
    expect(control('centerGatewayUrl').value).toBe('http://127.0.0.1:3456/')
    expect(control('requestTimeoutSec').value).toBe('60')
    control('save-settings').dispatchEvent(new Event('click', { cancelable: true }))
    await Bun.sleep(0)
    expect(stored).toMatchObject({ centerGatewayUrl: 'http://127.0.0.1:3456/', requestTimeoutSec: 60 })
    control('centerGatewayUrl').value = ''
    control('centerGatewayUrl').dispatchEvent(new Event('input'))
    control('save-settings').dispatchEvent(new Event('click', { cancelable: true }))
    await Bun.sleep(0)
    expect(stored.centerGatewayUrl).toBeUndefined()
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
