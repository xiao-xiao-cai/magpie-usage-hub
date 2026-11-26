import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

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
    expect(page.settingsView({})).toMatchObject({ enabled: false, initialMode: 'now', pollIntervalSec: '60', requestTimeoutSec: '30' })
    const saved = page.settingsView({ ...original, centralGatewayUrl: 'https://user:secret@usage.example.com/' })
    expect(saved.centralKeyFile).toBe('')
    expect(saved.centralGatewayUrl).toBe('')
    expect(JSON.stringify(saved)).not.toContain('synthetic\\key')
    expect(JSON.stringify(saved)).not.toContain('secret')

    const draft = { ...page.settingsView(original), pollIntervalSec: 60, requestTimeoutSec: 30 }
    expect(page.settingsPatch(draft, original)).not.toHaveProperty('centralKeyFile')
    expect(page.settingsPatch({ ...draft, centralKeyFile: 'D:\\keys\\usage.txt' }, original)).toMatchObject({
      centralKeyFile: 'D:\\keys\\usage.txt',
      centralGatewayUrl: 'https://usage.example.com/',
    })
    expect(() => page.settingsPatch({ ...draft, pollIntervalSec: Number.NaN }, original)).toThrow(/5–900/)
    expect(() => page.settingsPatch({ ...draft, centralKeyFile: 'relative.txt' }, original)).toThrow(/绝对文件路径/)
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
})
