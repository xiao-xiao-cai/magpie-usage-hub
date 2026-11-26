import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const script = readFileSync(new URL('../../ui/sources/sources.js', import.meta.url), 'utf8')
const adminToken = 'b'.repeat(64)
const pairingCode = 'a'.repeat(64)
const source = {
  id: 'b49664b2-d102-4e01-93b0-a67d696bd618', name: '合成来源', sourceCallerKeyId: 'fixture-key',
  sourceProviderId: 'fixture-provider', enabled: true, revision: 1, pollIntervalSec: 60, paired: false,
  pairingExpiresAt: new Date(Date.now() + 600_000).toISOString(), lastSeenAt: null, lastReportAt: null,
}

class Control extends EventTarget {
  checked = false
  disabled = false
  hidden = false
  value = ''
  textContent = ''
  children: Control[] = []
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value) }
  append(child: Control) { this.children.push(child) }
  replaceChildren(...children: Control[]) { this.children = children }
  reportValidity() { return true }
  setAttribute() {}
  focus() {}
  select() {}
  reset() {}
}

function harness(sources = [source]) {
  const controls = new Map<string, Control>()
  const requests: { path: string; init: RequestInit }[] = []
  const replies: (() => Promise<Response>)[] = []
  function control(id: string) {
    if (!controls.has(id)) controls.set(id, new Control())
    return controls.get(id)!
  }
  function reply(payload: unknown, status = 200) {
    replies.push(async () => Response.json(payload, { status }))
  }
  reply({ sources })
  runInNewContext(script, {
    document: { getElementById: control, querySelector: () => ({ content: adminToken }), createElement: () => new Control() },
    async fetch(path: string, init: RequestInit) {
      requests.push({ path, init })
      const next = replies.shift()
      if (!next) throw new Error('fixture_response_missing')
      return next()
    },
    AbortSignal, Event,
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  return { control, requests, replies, reply,
    click(id: string) { control(id).dispatchEvent(new Event('click')) },
    editFirst() { control('sources-rows').children[0].children.at(-1)!.children[0].dispatchEvent(new Event('click')) },
  }
}

describe('managed sources page', () => {
  test('creates a source once and puts the code in a field only after deliberate reveal', async () => {
    const ui = harness([])
    await Bun.sleep(0)
    ui.control('source-name').value = ' 合成来源 '
    ui.control('source-key').value = source.sourceCallerKeyId
    ui.control('source-provider').value = source.sourceProviderId
    ui.control('source-interval').value = '60'
    const pending = Promise.withResolvers<Response>()
    ui.replies.push(() => pending.promise)
    ui.click('add-button')
    ui.click('add-button')
    expect(ui.requests).toHaveLength(2)
    expect(ui.requests[1]).toMatchObject({ path: '../api/sources', init: { method: 'POST', credentials: 'omit',
      headers: { 'X-Magpie-Usage-Admin': adminToken, 'Content-Type': 'application/json' },
    } })
    expect(JSON.parse(String(ui.requests[1].init.body))).toEqual({ name: source.name, sourceCallerKeyId: source.sourceCallerKeyId,
      sourceProviderId: source.sourceProviderId, pollIntervalSec: 60, enabled: false,
    })
    pending.resolve(Response.json({ source: { ...source, enabled: false }, pairingCode }, { status: 201 }))
    await Bun.sleep(0)
    expect(ui.control('pairing-result').hidden).toBe(false)
    expect(ui.control('pairing-value').hidden).toBe(true)
    expect(ui.control('pairing-code').value).toBe('')
    ui.click('reveal-code')
    expect(ui.control('pairing-value').hidden).toBe(false)
    expect(ui.control('pairing-code').value).toBe(pairingCode)
    ui.click('dismiss-code')
    expect(ui.control('pairing-code').value).toBe('')
    expect(ui.control('pairing-result').hidden).toBe(true)
  })

  test('reconciles a conflicting revision without overwriting a remote edit to an untouched field', async () => {
    const ui = harness()
    await Bun.sleep(0)
    ui.editFirst()
    ui.control('edit-interval').value = '90'
    ui.reply({ error: { code: 'source_conflict' } }, 409)
    ui.reply({ sources: [{ ...source, revision: 2, enabled: false, pollIntervalSec: 80 }] })
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('edit-interval').value).toBe('90')
    expect(ui.control('save-source').disabled).toBe(true)
    expect(ui.control('review-latest').hidden).toBe(false)
    ui.click('review-latest')
    expect(ui.control('edit-interval').value).toBe('90')
    expect(ui.control('edit-enabled').checked).toBe(false)
    ui.reply({ source: { ...source, revision: 3, enabled: false, pollIntervalSec: 90 } })
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.requests.at(-1)?.path).toBe('../api/sources/settings')
    expect(JSON.parse(String(ui.requests.at(-1)?.init.body))).toEqual({ id: source.id, revision: 2, enabled: false, pollIntervalSec: 90 })
    expect(ui.control('edit-notice').textContent).toBe('来源设置已保存。')
  })

  test('requires a refresh after an ambiguous write and clears the pairing code after a peer pairs', async () => {
    const ui = harness()
    await Bun.sleep(0)
    ui.editFirst()
    ui.replies.push(async () => { throw new Error('fixture_response_lost') })
    ui.click('renew-code')
    await Bun.sleep(0)
    expect(ui.control('renew-code').disabled).toBe(true)
    ui.click('renew-code')
    expect(ui.requests).toHaveLength(2)
    ui.reply({ sources: [{ ...source, revision: 2 }] })
    ui.click('refresh-sources')
    await Bun.sleep(0)
    ui.reply({ source: { ...source, revision: 3 }, pairingCode })
    ui.click('renew-code')
    await Bun.sleep(0)
    expect(ui.requests.at(-1)?.path).toBe('../api/sources/pairing')
    ui.click('reveal-code')
    expect(ui.control('pairing-code').value).toBe(pairingCode)
    ui.reply({ sources: [{ ...source, revision: 4, paired: true, pairingExpiresAt: null }] })
    ui.click('refresh-sources')
    await Bun.sleep(0)
    expect(ui.control('pairing-result').hidden).toBe(true)
    expect(ui.control('pairing-code').value).toBe('')
    expect(ui.control('renew-code').hidden).toBe(true)
  })
})
