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
const settings = { role: 'center', enabled: true, centerGatewayUrl: 'http://127.0.0.1:3425/',
  ingestHost: '127.0.0.1', ingestPort: 3494, timeZone: 'Asia/Shanghai', requestTimeoutSec: 30,
}
const original = { ...settings, collectionMode: 'push', configRevision: revisionOne }

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
  test('defaults to a disabled center and validates its gateway, listener and time zone', () => {
    const defaults = { ...settings, enabled: false, ingestPort: '3494', requestTimeoutSec: '30',
      sourceGatewayUrl: 'http://127.0.0.1:3425/', centerIngestUrl: '', sourceId: '', reportKeyFile: '',
    }
    expect(page.settingsView({})).toEqual(defaults)
    expect(page.settingsView({ collectionMode: 'pull', role: 'center', enabled: true })).toEqual(defaults)
    expect(page.settingsView(original)).toEqual({ ...defaults, enabled: true })
    const draft = { ...settings, centerGatewayUrl: 'http://[::1]:3425', ingestHost: '::', requestTimeoutSec: 60 }
    expect(page.settingsPatch(draft)).toEqual({ ...draft, collectionMode: 'push', centerGatewayUrl: 'http://[::1]:3425/' })
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

  test('validates and saves the Windows sender fields and shows their readback', async () => {
    const draft = { role: 'sender', enabled: true, sourceGatewayUrl: 'http://127.0.0.1:3425',
      centerIngestUrl: 'http://198.51.100.1:3494', sourceId: 'b49664b2-d102-4e01-93b0-a67d696bd618',
      reportKeyFile: String.raw`C:\Magpie\usage-hub\report-key.txt`, requestTimeoutSec: 30,
    }
    expect(() => page.settingsPatch({ ...draft, sourceGatewayUrl: draft.centerIngestUrl })).toThrow(/回环/)
    expect(() => page.settingsPatch({ ...draft, centerIngestUrl: `${draft.centerIngestUrl}/checkpoint` })).toThrow(/中心接收根地址/)
    expect(() => page.settingsPatch({ ...draft, sourceId: 'local' })).toThrow(/来源 ID/)
    expect(() => page.settingsPatch({ ...draft, reportKeyFile: 'report-key.txt' })).toThrow(/完整路径/)
    const patch = page.settingsPatch(draft)
    expect(patch).toEqual({ ...draft, collectionMode: 'push', sourceGatewayUrl: `${draft.sourceGatewayUrl}/`,
      centerIngestUrl: `${draft.centerIngestUrl}/`,
    })
    const ui = harness({})
    await ui.refresh()
    await ui.submit(patch)
    expect(ui.last).toMatchObject({ result: 'confirmed', saved: patch })
    expect(page.settingsView(ui.last.saved!)).toMatchObject({ ...draft, sourceGatewayUrl: `${draft.sourceGatewayUrl}/`,
      centerIngestUrl: `${draft.centerIngestUrl}/`, requestTimeoutSec: '30',
    })
  })

  test('opens the service root before navigating to the requested dashboard', () => {
    const base = 'https://usage.example.com/plugins/synthetic-token/'
    const service = `${base}_magpie/service/`
    const pageUrl = `${base}index.html`
    expect(page.pageServiceLink(service, pageUrl, original)).toBe(`${service}#revision=${revisionOne}&view=dashboard`)
    expect(page.pageServiceLink(service, pageUrl, { enabled: true })).toBe(service)
    expect(page.pageServiceLink(service, pageUrl, { ...original, enabled: false })).toBe(`${service}#revision=${revisionOne}`)
    expect(page.pageServiceLink(service, pageUrl, { ...original, role: 'sender' })).toBe(`${service}#revision=${revisionOne}`)
    expect(page.pageServiceLink('', pageUrl, original)).toBe('')
    expect(page.pageServiceLink(service, 'https://elsewhere.example/', original)).toBe('')
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
    runInNewContext(await Bun.file(new URL('../../page/configuration.js', import.meta.url)).text(), {
      usageHubOptions: page,
      document: { getElementById: control, createElement: () => new Control() },
      window: { location: { href: 'https://usage.example.com/plugins/fixture/' },
        magpie: { options: { async get() { return { ...stored } }, async set(next: Options) { stored = next } } },
      },
      Event, setTimeout, clearTimeout,
    })
    await Bun.sleep(0)
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
    expect(different.last).toMatchObject({ result: 'readback_mismatch', saved: original, differences: ['单次请求超时'] })
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
