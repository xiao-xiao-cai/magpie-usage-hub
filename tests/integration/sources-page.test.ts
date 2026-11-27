import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const script = readFileSync(new URL('../../ui/sources/sources.js', import.meta.url), 'utf8')
const adminToken = 'b'.repeat(64)
const fixtureKey = 'synthetic-readonly-key'
const source = { id: 'b49664b2-d102-4e01-93b0-a67d696bd618', name: '合成来源',
  gatewayUrl: 'https://gateway.example.com/', enabled: true, credentialConfigured: true,
}

class Control extends EventTarget {
  checked = false
  disabled = false
  hidden = false
  value = ''
  textContent = ''
  children: Control[] = []
  append(child: Control) { this.children.push(child) }
  replaceChildren(...children: Control[]) { this.children = children }
  reportValidity() { return true }
  setAttribute() {}
  focus() {}
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
  reply({ revision: sources.length, sources })
  runInNewContext(script, {
    document: { getElementById: control, querySelector: () => ({ content: adminToken }), createElement: () => new Control() },
    async fetch(path: string, init: RequestInit) {
      requests.push({ path, init })
      const next = replies.shift()
      if (!next) throw new Error('fixture_response_missing')
      return next()
    },
    AbortSignal, Event, URL,
  })
  return { control, requests, replies, reply,
    click(id: string) { control(id).dispatchEvent(new Event('click', { cancelable: true })) },
    input(id: string, value: string | boolean) {
      const input = control(id)
      if (typeof value === 'boolean') input.checked = value
      else input.value = value
      input.dispatchEvent(new Event('input'))
    },
    editFirst() { control('sources-rows').children[0].children.at(-1)!.children[0].dispatchEvent(new Event('click')) },
    lastBody() { return JSON.parse(String(requests.at(-1)?.init.body)) as Record<string, unknown> },
    testPass() { reply({ status: 'ok', checkedAt: new Date().toISOString(), failure: null }) },
  }
}

describe('pull sources page', () => {
  test('registers a tested source once and clears the Key after saving', async () => {
    const ui = harness([])
    await Bun.sleep(0)
    ui.input('source-name', ' 合成来源 ')
    ui.input('source-gateway', 'https://gateway.example.com')
    ui.input('source-key', fixtureKey)
    ui.click('save-source')
    expect(ui.requests).toHaveLength(1)

    ui.testPass()
    ui.click('test-source')
    await Bun.sleep(0)
    expect(ui.control('source-notice').textContent).toBe('连接成功。')
    expect(ui.requests.at(-1)?.path).toBe('../api/sources/test')
    expect(ui.lastBody()).toEqual({ revision: 0, name: source.name, gatewayUrl: source.gatewayUrl, key: fixtureKey, enabled: true })
    const pending = Promise.withResolvers<Response>()
    ui.replies.push(() => pending.promise)
    ui.click('save-source')
    ui.click('save-source')
    expect(ui.requests).toHaveLength(3)
    expect(ui.requests.at(-1)).toMatchObject({ path: '../api/sources', init: { method: 'POST', credentials: 'omit',
      headers: { 'X-Magpie-Usage-Admin': adminToken, 'Content-Type': 'application/json' },
    } })
    pending.resolve(Response.json({ revision: 1, sources: [source] }, { status: 201 }))
    await Bun.sleep(0)
    expect(ui.control('source-key').value).toBe('')
    expect(ui.control('source-notice').textContent).toBe('来源已保存。')
    expect(ui.control('sources-rows').children[0].children[3].textContent).toBe('已配置')
  })

  test('requires a new Key for an edited address and invalidates a stale test result', async () => {
    const ui = harness()
    await Bun.sleep(0)
    ui.editFirst()
    expect(ui.control('source-key').value).toBe('')
    ui.input('source-gateway', 'https://changed.example.com/')
    ui.click('test-source')
    expect(ui.requests).toHaveLength(1)
    expect(ui.control('source-notice').textContent).toContain('请输入')
    ui.input('source-key', fixtureKey)
    ui.reply({ status: 'unavailable', failure: { code: 'restricted_key' } })
    ui.click('test-source')
    await Bun.sleep(0)
    expect(ui.control('source-notice').textContent).toContain('用量范围受限')
    expect(ui.control('save-source').disabled).toBe(true)
    ui.testPass()
    ui.click('test-source')
    await Bun.sleep(0)
    expect(ui.control('save-source').disabled).toBe(false)
    ui.input('source-key', 'synthetic-rotated-key')
    expect(ui.control('save-source').disabled).toBe(true)
  })

  test('adopts the latest revision and preserves an address draft bound to its replacement Key', async () => {
    const ui = harness()
    await Bun.sleep(0)
    ui.editFirst()
    ui.input('source-key', fixtureKey)
    ui.testPass()
    ui.click('test-source')
    await Bun.sleep(0)
    ui.reply({ error: { code: 'revision_conflict' } }, 409)
    ui.reply({ revision: 2, sources: [{ ...source, gatewayUrl: 'https://other.example.com/', enabled: false }] })
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('source-key').value).toBe(fixtureKey)
    expect(ui.control('revision-review').hidden).toBe(false)
    expect(ui.control('save-source').disabled).toBe(true)
    ui.click('review-latest')
    expect(ui.control('source-gateway').value).toBe(source.gatewayUrl)
    expect(ui.control('source-enabled').checked).toBe(false)
    expect(ui.control('save-source').disabled).toBe(true)
    ui.testPass()
    ui.click('test-source')
    await Bun.sleep(0)
    expect(ui.lastBody()).toEqual({ id: source.id, revision: 2, name: source.name, gatewayUrl: source.gatewayUrl,
      key: fixtureKey, enabled: false,
    })
    expect(ui.control('save-source').disabled).toBe(false)
  })

  test('keeps a draft after write failure and saves enablement with the stored credential', async () => {
    const ui = harness()
    await Bun.sleep(0)
    ui.editFirst()
    ui.input('source-enabled', false)
    ui.reply({ error: { code: 'source_save_failed' } }, 503)
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.lastBody()).toEqual({ id: source.id, revision: 1, name: source.name, gatewayUrl: source.gatewayUrl, enabled: false })
    expect(ui.control('source-enabled').checked).toBe(false)
    expect(ui.control('source-notice').textContent).toContain('可重试')
    ui.reply({ revision: 2, sources: [{ ...source, enabled: false }] })
    ui.click('save-source')
    await Bun.sleep(0)
    expect(ui.control('sources-rows').children[0].children[2].textContent).toBe('已停用')
    expect(ui.control('source-notice').textContent).toBe('来源已保存。')
  })
})
