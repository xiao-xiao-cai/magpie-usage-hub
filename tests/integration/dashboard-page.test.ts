import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const dashboard = readFileSync(new URL('../../ui/dashboard/dashboard.js', import.meta.url), 'utf8')
const diagnostics = readFileSync(new URL('../../ui/status.js', import.meta.url), 'utf8')
const observedAt = '2026-11-27T10:00:00.000Z'
const local = { name: '中心本机', status: 'ok', since: '2026-11-27T00:00:00+08:00', checkedAt: observedAt,
  totals: { calls: 2, input: 11, output: 12, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 2 }, failure: null,
}
const windows = { name: 'Windows 合成来源', status: 'unavailable', since: null, checkedAt: observedAt,
  totals: null, failure: { code: 'timeout' },
}

class Control extends EventTarget {
  hidden = false
  value = ''
  textContent = ''
  children: Control[] = []
  attributes = new Map<string, string>()
  append(child: Control) { this.children.push(child) }
  replaceChildren(...children: Control[]) { this.children = children }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
}

function documentHarness() {
  const controls = new Map<string, Control>()
  function control(id: string) {
    if (!controls.has(id)) controls.set(id, new Control())
    return controls.get(id)!
  }
  return { control, document: { getElementById: control, createElement: () => new Control() } }
}

function dashboardHarness() {
  const { control, document } = documentHarness()
  const requests: { path: string; signal?: AbortSignal | null; pending: PromiseWithResolvers<Response> }[] = []
  control('period').value = '7d'
  runInNewContext(dashboard, {
    document, AbortController, URLSearchParams,
    fetch(path: string, init: RequestInit) {
      const pending = Promise.withResolvers<Response>()
      requests.push({ path, signal: init.signal, pending })
      return pending.promise
    },
  })
  return { control, requests, select(period: string) {
    control('period').value = period
    control('period').dispatchEvent(new Event('change'))
  } }
}

function usage(period: string, sources: object[]) {
  return Response.json({ schema: 'magpie-usage-hub/usage-v2', period, sources })
}

describe('dashboard page', () => {
  test('shows native period offset and zero cost alongside missing prices and a failed source', async () => {
    const ui = dashboardHarness()
    ui.requests[0].pending.resolve(usage('7d', [local, windows]))
    await Bun.sleep(0)
    expect(ui.requests[0].path).toBe('../api/usage?period=7d')
    const [center, remote] = ui.control('summary-rows').children
    expect(center.children[1].children[0].textContent).toContain('+08:00')
    expect(center.children.map(cell => cell.textContent).slice(2, 7)).toEqual(['2', '11 / 12', '0 / 0', '0.00', '2'])
    expect(remote.children[7].textContent).toContain('暂不可用 · 连接超时')
    expect(ui.control('results').hidden).toBe(false)
  })

  test('preserves the latest period across late success and failure', async () => {
    const ui = dashboardHarness()
    ui.select('30d')
    ui.select('today')
    expect(ui.requests[0].signal?.aborted).toBe(true)
    ui.requests[0].pending.reject(new Error('synthetic late failure'))
    await Bun.sleep(0)
    expect(ui.control('results').attributes.get('aria-busy')).toBe('true')
    ui.requests[2].pending.resolve(usage('today', [{ ...local, name: '今日结果' }]))
    await Bun.sleep(0)
    ui.requests[1].pending.resolve(usage('30d', [{ ...local, name: '迟到结果' }]))
    await Bun.sleep(0)
    expect(ui.control('results').attributes.get('aria-busy')).toBe('false')
    expect(ui.control('summary-rows').children[0].children[0].textContent).toBe('今日结果')
  })

  test('opens the dashboard after the service root sees the applied Options revision', async () => {
    const { control, document } = documentHarness()
    const revision = '11111111-1111-4111-8111-111111111111'
    let ready = false
    const navigations: string[] = []
    runInNewContext(diagnostics, {
      document, AbortSignal, URLSearchParams, setInterval: () => 1,
      location: { hash: `#revision=${revision}&view=dashboard`, replace: (path: string) => navigations.push(path) },
      fetch: async () => Response.json({ schema: 'magpie-usage-hub/status-v1', ready, phase: ready ? 'ready' : 'starting',
        loadedRevision: revision, appliedRevision: ready ? revision : null,
      }),
    })
    await Bun.sleep(0)
    expect(navigations).toHaveLength(0)
    ready = true
    control('refresh').dispatchEvent(new Event('click'))
    await Bun.sleep(0)
    expect(navigations).toEqual(['dashboard/'])
  })
})
