import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const script = readFileSync(new URL('../../ui/sources/sources.js', import.meta.url), 'utf8')
const adminToken = 'b'.repeat(64)
const digest = 'a'.repeat(64)
const revisionOne = '11111111-1111-4111-8111-111111111111'
const revisionTwo = '22222222-2222-4222-8222-222222222222'
const revisionThree = '33333333-3333-4333-8333-333333333333'
const source = { id: 'b49664b2-d102-4e01-93b0-a67d696bd618', name: '合成来源', enabled: true, isLocal: false,
  phase: 'backfill', hasMore: false, lastSeenAt: null, lastPageAt: null, lastSyncedAt: null, recoveryReason: null,
  rebuildAllowed: false, gap: null, credentials: { current: true, pending: false, pendingVerified: false },
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
  setAttribute() {}
  focus() {}
}

function harness(sources: object[] = [source]) {
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
  reply({ revision: revisionOne, sources })
  runInNewContext(script, {
    document: { getElementById: control, querySelector: () => ({ content: adminToken }), createElement: () => new Control() },
    async fetch(path: string, init: RequestInit) {
      requests.push({ path, init })
      const next = replies.shift()
      if (!next) throw new Error('fixture_response_missing')
      return next()
    },
    AbortSignal, Event, Intl,
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
  }
}

describe('source management page', () => {
  test('registers a source once, clears the digest and reveals its source ID', async () => {
    const ui = harness([])
    await Bun.sleep(0)
    ui.input('source-name', ' 合成来源 ')
    ui.input('source-digest', 'short')
    ui.click('save-source')
    expect(ui.control('source-notice').textContent).toContain('64 位')
    expect(ui.requests).toHaveLength(1)

    ui.input('source-digest', digest.toUpperCase())
    const pending = Promise.withResolvers<Response>()
    ui.replies.push(() => pending.promise)
    ui.click('save-source')
    ui.click('save-source')
    expect(ui.requests).toHaveLength(2)
    expect(ui.requests.at(-1)).toMatchObject({ path: '../api/sources', init: { method: 'POST', credentials: 'omit',
      headers: { 'X-Magpie-Usage-Admin': adminToken, 'Content-Type': 'application/json' },
    } })
    expect(ui.lastBody()).toEqual({ revision: revisionOne, action: 'create', name: source.name, digest, enabled: true })
    pending.resolve(Response.json({ revision: revisionTwo, sources: [source] }, { status: 201 }))
    await Bun.sleep(0)
    expect(ui.control('source-digest').value).toBe('')
    expect(ui.control('source-id').textContent).toBe(source.id)
    expect(ui.control('source-notice').textContent).toBe('来源已登记。')
    expect(ui.control('sources-rows').children[0].children[1].textContent).toBe('等待来源认证')
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

  test('allows same-source recovery on a paused source after explicit confirmation', async () => {
    const paused = { ...source, enabled: false, phase: 'paused', recoveryReason: 'cursor_reset', rebuildAllowed: true }
    const ui = harness([paused])
    await Bun.sleep(0)
    ui.editFirst()
    expect(ui.control('recovery-tools').hidden).toBe(false)
    ui.click('rebuild-source')
    expect(ui.control('confirmation-text').textContent).toContain('仍是原来源')
    ui.click('cancel-action')
    expect(ui.control('action-confirmation').hidden).toBe(true)
    expect(ui.requests).toHaveLength(1)
    ui.click('rebuild-source')
    ui.reply({ revision: revisionTwo, sources: [{ ...paused, rebuildAllowed: false }] })
    ui.click('confirm-action')
    await Bun.sleep(0)
    expect(ui.lastBody()).toEqual({ id: source.id, revision: revisionOne, action: 'rebuild' })
    expect(ui.control('source-notice').textContent).toContain('已确认重建')
    expect(ui.control('recovery-tools').hidden).toBe(true)
  })
})
