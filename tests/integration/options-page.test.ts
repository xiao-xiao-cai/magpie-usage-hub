import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { readSyncOptions } from '../../src/options.ts'

type Options = Record<string, unknown>
type ViewState = {
  result: string
  action: string
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
  settingsPatch(draft: Options, saved: Options): Options
  recoveryBinding(saved: Options): Options | null
  recoveryDraft(binding: Options | null, kind: string, from: string, to: string, now?: number): Options
  createSession(
    bridge: { get(): Promise<unknown>; set(value: Options): Promise<void> },
    publish: (state: ViewState) => void,
  ): {
    refresh(): Promise<void>
    submit(action: string, patch: Options): Promise<void>
    adoptLatest(): void
  }
}

const source = readFileSync(new URL('../../page/options.js', import.meta.url), 'utf8')
const page = runInNewContext(`${source}\nusageHubOptions`, { crypto, URL }) as PageOptions
const revisionOne = '11111111-1111-4111-8111-111111111111'

const original = {
  enabled: true,
  mode: 'continuous',
  sourceGatewayUrl: 'http://127.0.0.1:3425',
  sourceCallerKeyId: 'synthetic-key-id',
  centralGatewayUrl: 'https://usage.example.com',
  centralKeyFile: 'C:\\synthetic\\key.txt',
  configRevision: revisionOne,
}

function harness() {
  let stored: Options = { ...original }
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
    views,
    get last() { return views.at(-1)! },
    update(next: Options) { stored = { ...stored, ...next } },
    nextRead(read: () => Promise<unknown>) { readNext = read },
    failWrite() { rejectWrite = true },
    afterWrite(run: () => void) { afterWrite = run },
  }
}

describe('Options configuration page', () => {
  test('starts disabled and shows credential state without the saved path', () => {
    expect(page.settingsView({})).toMatchObject({ enabled: false, mode: 'managed', initialMode: 'now', pollIntervalSec: '60', requestTimeoutSec: '30' })
    const saved = page.settingsView({ ...original, centralGatewayUrl: 'https://user:secret@usage.example.com/' })
    expect(saved.centralKeyFile).toBe('')
    expect(saved.centralGatewayUrl).toBe('')
    expect(JSON.stringify(saved)).not.toContain('synthetic\\key')
    expect(JSON.stringify(saved)).not.toContain('secret')

    const draft = { ...page.settingsView(original), sourceProviderId: 'synthetic-provider', pollIntervalSec: 60, requestTimeoutSec: 30 }
    expect(page.settingsPatch(draft, original)).not.toHaveProperty('centralKeyFile')
    expect(page.settingsPatch({ ...draft, centralKeyFile: 'D:\\keys\\usage.txt' }, original)).toMatchObject({
      centralKeyFile: 'D:\\keys\\usage.txt',
      centralGatewayUrl: 'https://usage.example.com/',
    })
    expect(() => page.settingsPatch({ ...draft, pollIntervalSec: Number.NaN }, original)).toThrow(/5–900/)
    expect(() => page.settingsPatch({ ...draft, centralKeyFile: 'relative.txt' }, original)).toThrow(/绝对文件路径/)
  })

  test('saves managed enrollment without exposing the file path or changing the saved manual scope', async () => {
    const ui = harness()
    const recoveryRequest = { id: page.createId(), kind: 'cursor', from: '2025-11-01T00:00:00.000Z',
      binding: page.recoveryBinding(original),
    }
    ui.update({ recoveryRequest })
    await ui.refresh()
    const draft = { ...page.settingsView(original), mode: 'managed', pairingCodeFile: 'C:\\synthetic\\pair.txt', requestTimeoutSec: 30 }
    const patch = page.settingsPatch(draft, original)
    expect(patch).toEqual({
      role: 'source', enabled: true, mode: 'managed', sourceGatewayUrl: 'http://127.0.0.1:3425/',
      centralGatewayUrl: 'https://usage.example.com/', pairingCodeFile: draft.pairingCodeFile, requestTimeoutSec: 30,
    })
    expect(() => page.settingsPatch({ ...draft, pairingCodeFile: 'pair.txt' }, original)).toThrow(/绝对文件路径/)
    expect(page.settingsPatch({ ...draft, pairingCodeFile: '' }, original)).not.toHaveProperty('pairingCodeFile')
    await ui.submit('settings', patch)
    expect(ui.last).toMatchObject({ result: 'confirmed', saved: { ...original, ...patch, recoveryRequest, configRevision: expect.any(String) } })
    expect(page.settingsView(ui.last.saved!)).toMatchObject({ mode: 'managed', pairingCodeFile: '' })
    expect(page.recoveryBinding(ui.last.saved!)).toBeNull()
  })

  test('enables a managed-only center without a manual ingest credential file', () => {
    const view = page.settingsView({ role: 'center' })
    const patch = page.settingsPatch({ ...view, enabled: true, centerGatewayUrl: 'http://127.0.0.1:3425/',
      ingestPort: 3494, requestTimeoutSec: 30,
    }, {})
    expect(patch).toMatchObject({ role: 'center', enabled: true, ingestHost: '127.0.0.1', ingestPort: 3494 })
    expect(patch).not.toHaveProperty('ingestKeyFile')
  })

  test('requires a provider for a new or explicit manual source', () => {
    const draft = { ...page.settingsView(original), pollIntervalSec: 60, requestTimeoutSec: 30 }
    expect(() => page.settingsPatch(draft, {})).toThrow(/供应商 ID/)
    expect(() => page.settingsPatch(draft, { ...original, role: 'source' })).toThrow(/供应商 ID/)
    expect(() => page.settingsPatch({ ...draft, sourceProviderId: 'invalid id' }, original)).toThrow(/供应商 ID/)
    const patch = page.settingsPatch({ ...draft, sourceProviderId: 'fixture.provider' }, original)
    expect(patch).toMatchObject({ role: 'source', enabled: true, sourceProviderId: 'fixture.provider' })
    expect(page.recoveryBinding({ ...original, ...patch })).toHaveProperty('sourceProviderId', 'fixture.provider')
    const keyPath = fileURLToPath(new URL('../../synthetic-key.txt', import.meta.url))
    expect(readSyncOptions({ ...original, ...patch, centralKeyFile: keyPath }))
      .toHaveProperty('sourceProviderId', 'fixture.provider')
  })

  test('preserves the legacy source binding across saves, disable and re-enable', async () => {
    const ui = harness()
    const centralKeyFile = fileURLToPath(new URL('../../synthetic-key.txt', import.meta.url))
    const binding = page.recoveryBinding(original)
    const recoveryRequest = { id: page.createId(), kind: 'cursor', from: '2025-11-01T00:00:00.000Z', binding }
    ui.update({ centralKeyFile, recoveryRequest })
    await ui.refresh()

    for (const enabled of [true, false, true]) {
      const saved = ui.last.saved!
      const draft = { ...page.settingsView(saved), enabled, pollIntervalSec: 120, requestTimeoutSec: 30 }
      await ui.submit('settings', page.settingsPatch(draft, saved))
      expect(ui.last).toMatchObject({ result: 'confirmed', saved: { enabled, pollIntervalSec: 120, recoveryRequest } })
      expect(ui.last.saved).not.toHaveProperty('role')
      expect(ui.last.saved).not.toHaveProperty('sourceProviderId')
      expect(page.recoveryBinding(ui.last.saved!)).toEqual(enabled ? binding : null)
      const syncOptions = readSyncOptions(ui.last.saved)
      if (enabled) expect(syncOptions).toMatchObject({ centralKeyFile, pollIntervalSec: 120 })
      else expect(syncOptions).toBeNull()
    }
  })

  test('keeps inactive source settings and masks the center credential across save readback', async () => {
    const ui = harness()
    const center = { ...original, role: 'center', centerGatewayUrl: 'http://127.0.0.1/', ingestKeyFile: '/config/synthetic-keys.json' }
    const view = page.settingsView(center)
    expect(view).toMatchObject({ role: 'center', enabled: true, ingestKeyFile: '', ingestHost: '127.0.0.1', ingestPort: '3494' })
    expect(view.centralKeyFile).toBe('')
    expect(page.recoveryBinding(center)).toBeNull()
    const draft = { ...view, ingestPort: 3494, requestTimeoutSec: 30 }
    expect(() => page.settingsPatch({ ...draft, centerGatewayUrl: 'https://elsewhere.example/' }, center)).toThrow(/本机中心网关/)
    expect(() => page.settingsPatch({ ...draft, ingestPort: 80 }, center)).toThrow(/网关的端口不同/)
    expect(() => page.settingsPatch({ ...draft, ingestPort: 3493 }, center)).toThrow(/插件页面服务/)
    expect(() => page.settingsPatch({ ...draft, ingestHost: '192.0.2.10' }, center)).toThrow(/监听地址/)
    expect(() => page.settingsPatch({ ...draft, ingestKeyFile: 'relative.txt' }, center)).toThrow(/绝对文件路径/)
    await ui.refresh()
    const patch = page.settingsPatch({ ...draft, ingestHost: '0.0.0.0', ingestKeyFile: center.ingestKeyFile }, ui.last.saved!)
    await ui.submit('settings', patch)
    expect(ui.last).toMatchObject({ result: 'confirmed', saved: { ...original, ...patch, configRevision: expect.any(String) } })
    expect(page.settingsPatch(draft, ui.last.saved!)).not.toHaveProperty('ingestKeyFile')
    expect(page.recoveryBinding(ui.last.saved!)).toBeNull()
  })

  test('links the saved role to the corresponding page service under the current Web token', () => {
    const base = 'https://usage.example.com/plugins/synthetic-token/'
    const service = `${base}_magpie/service/`
    const pageUrl = `${base}index.html`
    expect(page.pageServiceLink(service, pageUrl, original)).toBe(`${service}#revision=${revisionOne}`)
    expect(page.pageServiceLink(service, pageUrl, { role: 'center', enabled: true })).toBe(`${service}dashboard/`)
    expect(page.pageServiceLink(service, pageUrl, { role: 'center', enabled: false })).toBe('')
    expect(page.pageServiceLink('', pageUrl, original)).toBe('')
    expect(page.pageServiceLink(service, 'https://elsewhere.example/', original)).toBe('')
  })

  test('merges foreign fields read immediately before submission and verifies the whole readback', async () => {
    const ui = harness()
    await ui.refresh()
    ui.update({ customUse: { enabled: true, rows: [1] } })
    ui.afterWrite(() => ui.update({ customUse: { rows: [1], enabled: true } }))
    await ui.submit('settings', { pollIntervalSec: 45 })
    expect(ui.writes).toHaveLength(1)
    expect(ui.writes[0]).toMatchObject({ pollIntervalSec: 45, customUse: { enabled: true, rows: [1] } })
    expect(page.revision(ui.writes[0].configRevision)).toBe(String(ui.writes[0].configRevision))
    expect(ui.writes[0].configRevision).not.toBe(revisionOne)
    expect(ui.last.result).toBe('confirmed')
  })

  test('keeps the baseline and stops a write when a managed field changed in another window', async () => {
    const ui = harness()
    await ui.refresh()
    ui.update({ centralKeyFile: 'C:\\synthetic\\changed.txt', pollIntervalSec: 50 })
    await ui.submit('settings', { requestTimeoutSec: 20 })
    expect(ui.writes).toHaveLength(0)
    expect(ui.last).toMatchObject({ result: 'conflict', saved: original, differences: ['上报凭据文件路径', '轮询间隔'] })
    expect(JSON.stringify(ui.last.differences)).not.toContain('changed.txt')
    ui.adoptLatest()
    await ui.submit('settings', { requestTimeoutSec: 20 })
    expect(ui.last.result).toBe('confirmed')
    expect(ui.writes[0]).toMatchObject({ pollIntervalSec: 50, requestTimeoutSec: 20 })
  })

  test('retains a disabled role switch after another window enables the saved role', async () => {
    class Control extends EventTarget {
      checked = false
      disabled = false
      value = ''
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
    let stored: Options = { ...original, enabled: false, centerGatewayUrl: 'http://127.0.0.1:3425/' }
    runInNewContext(await Bun.file(new URL('../../page/configuration.js', import.meta.url)).text(), {
      usageHubOptions: page,
      document: { getElementById: control, createElement: () => new Control() },
      window: {
        location: { href: 'https://usage.example.com/plugins/fixture/' },
        magpie: { options: { async get() { return { ...stored } }, async set(next: Options) { stored = next } } },
      },
      Event, setTimeout, clearTimeout,
    })
    await Bun.sleep(0)
    control('role').value = 'center'
    control('role').dispatchEvent(new Event('change'))
    stored = { ...stored, enabled: true, configRevision: page.createId() }
    control('reload-options').dispatchEvent(new Event('click'))
    await Bun.sleep(0)
    control('rebase-options').dispatchEvent(new Event('click'))
    expect(control('role').value).toBe('center')
    expect(control('enabled').checked).toBe(false)
    control('save-settings').dispatchEvent(new Event('click', { cancelable: true }))
    await Bun.sleep(0)
    expect(stored).toMatchObject({ role: 'center', enabled: false })
  })

  test('retains the prior saved view when the bridge rejects a write', async () => {
    const ui = harness()
    await ui.refresh()
    ui.failWrite()
    await ui.submit('settings', { requestTimeoutSec: 20 })
    expect(ui.last).toMatchObject({ result: 'write_failed', saved: original, writing: false, pending: false })
  })

  test('retries a failed readback without sending a second write', async () => {
    const ui = harness()
    await ui.refresh()
    ui.afterWrite(() => ui.nextRead(async () => { throw new Error('synthetic readback error') }))
    await ui.submit('settings', { requestTimeoutSec: 20 })
    expect(ui.last).toMatchObject({ result: 'readback_failed', saved: original, pending: true })
    await ui.submit('settings', { requestTimeoutSec: 20 })
    expect(ui.writes).toHaveLength(1)
    await ui.refresh()
    expect(ui.last).toMatchObject({ result: 'confirmed', saved: { requestTimeoutSec: 20 }, pending: false })
    expect(ui.writes).toHaveLength(1)
  })

  test('lists conflicting fields and keeps the saved view after an unequal readback', async () => {
    const ui = harness()
    await ui.refresh()
    ui.afterWrite(() => ui.update({ requestTimeoutSec: 30, customUse: { value: 'other' } }))
    await ui.submit('settings', { requestTimeoutSec: 20 })
    expect(ui.last).toMatchObject({
      result: 'readback_mismatch', saved: original, differences: ['单次请求超时', '其他选项'], pending: false,
    })
  })

  test('keeps the new refresh busy when an older response succeeds first', async () => {
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

  test('keeps the latest refresh result if an older request fails later', async () => {
    const ui = harness()
    const old = Promise.withResolvers<Options>()
    ui.nextRead(() => old.promise)
    const older = ui.refresh()
    await ui.refresh()
    old.reject(new Error('synthetic delayed error'))
    await older
    expect(ui.last).toMatchObject({ result: 'loaded', saved: original, refreshing: false })
  })

  test('allows only one write while an operation is underway', async () => {
    const ui = harness()
    await ui.refresh()
    const preflight = Promise.withResolvers<Options>()
    ui.nextRead(() => preflight.promise)
    const first = ui.submit('settings', { requestTimeoutSec: 20 })
    await ui.submit('settings', { requestTimeoutSec: 30 })
    expect(ui.last).toMatchObject({ result: 'writing', writing: true })
    preflight.resolve(original)
    await first
    expect(ui.writes).toHaveLength(1)
    expect(ui.writes[0].requestTimeoutSec).toBe(20)
  })

  test('encodes the confirmed recovery interval and supports withdrawing its Options request', async () => {
    const ui = harness()
    await ui.refresh()
    const binding = page.recoveryBinding(original)
    const from = '2026-11-26T00:00'
    const to = '2026-11-26T01:00:01'
    const now = new Date('2026-11-26T02:00').getTime()
    const draft = page.recoveryDraft(binding, 'range', from, to, now)
    expect(draft).toEqual({
      binding: {
        sourceGatewayUrl: 'http://127.0.0.1:3425/', centralGatewayUrl: 'https://usage.example.com/',
        sourceCallerKeyId: 'synthetic-key-id', initialMode: 'now',
      },
      kind: 'range', from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    })
    expect(page.recoveryDraft(binding, 'cursor', from, '', now)).not.toHaveProperty('to')
    expect(() => page.recoveryDraft(binding, 'range', from, from, now)).toThrow(/晚于起点/)
    expect(() => page.recoveryDraft(binding, 'range', from, to, new Date(from).getTime())).toThrow(/当前时间/)
    expect(() => page.recoveryDraft(binding, 'cursor', '2026-02-31T00:00', '', now)).toThrow(/有效的本地时间/)
    expect(page.recoveryBinding({ ...original, enabled: false })).toBeNull()

    const recoveryRequest = { ...draft, id: page.createId() }
    await ui.submit('recovery', { recoveryRequest })
    expect(page.revision(recoveryRequest.id)).toBe(recoveryRequest.id)
    expect(ui.last).toMatchObject({ result: 'confirmed', action: 'recovery', saved: { recoveryRequest } })
    await ui.submit('settings', { enabled: false })
    expect(ui.last.saved).toMatchObject({ recoveryRequest, enabled: false })
    await ui.submit('withdraw', {})
    expect(ui.last).toMatchObject({ result: 'confirmed', action: 'withdraw', saved: { enabled: false } })
    expect(ui.last.saved).not.toHaveProperty('recoveryRequest')
  })

  test('retains a request at the same scope but clears it when saving a different provider', async () => {
    const ui = harness()
    const source = { ...original, role: 'source', sourceProviderId: 'fixture-provider' }
    const recoveryRequest = { id: page.createId(), kind: 'cursor', from: '2025-11-01T00:00:00.000Z',
      binding: page.recoveryBinding(source),
    }
    ui.update({ ...source, recoveryRequest })
    await ui.refresh()
    await ui.submit('settings', { role: 'center', enabled: false })
    expect(ui.last.saved).toMatchObject({ sourceProviderId: 'fixture-provider', recoveryRequest })
    await ui.submit('settings', { role: 'source', enabled: true, sourceProviderId: 'other-provider' })
    expect(ui.last.saved).not.toHaveProperty('recoveryRequest')
  })
})
