import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const dashboard = readFileSync(new URL('../../ui/dashboard/dashboard.js', import.meta.url), 'utf8')
const diagnostics = readFileSync(new URL('../../ui/status.js', import.meta.url), 'utf8')
const observedAt = '2026-11-27T10:00:00.000Z'
const range = { from: '2026-11-27T00:00:00.000Z', to: '2026-11-27T01:00:00.000Z', timeZone: 'Asia/Shanghai' }
const totals = { calls: 2, input: 11, output: 12, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 2 }
const local = { id: 'local', name: '中心本机', freshness: 'current', lastSyncedAt: observedAt, hasPublishedData: true,
  coverage: { from: range.from, to: range.from }, totals, buckets: [], models: [{ model: '', totals }], gap: null,
}
const windows = { ...local, id: '01ed2b80-c848-48f1-b7a2-5852505416d5', name: 'Windows 合成来源', freshness: 'offline' }
const row = { sourceId: windows.id, model: '', t: '2026-11-27T08:00:00+08:00', via: 'through',
  handedOn: true, input: 0, output: 11, cacheRead: 0, cacheWrite: 0, reasoning: 0, cacheUnknown: true,
  cost: null, status: null, durationMs: 0,
}
const queryToken = 'e'.repeat(64)

class Control extends EventTarget {
  hidden = false
  value = ''
  textContent = ''
  dateTime = ''
  children: Control[] = []
  attributes = new Map<string, string>()
  append(child: Control) { this.children.push(child) }
  replaceChildren(...children: Control[]) { this.children = children }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  focus() {}
}

function documentHarness() {
  const controls = new Map<string, Control>()
  function control(id: string) {
    if (!controls.has(id)) controls.set(id, new Control())
    return controls.get(id)!
  }
  return { control, document: { getElementById: control, querySelector: () => ({ content: queryToken }),
    createElement: () => new Control() },
  }
}

function dashboardHarness() {
  const { control, document } = documentHarness()
  const requests: { path: string; init: RequestInit; pending: PromiseWithResolvers<Response> }[] = []
  control('period').value = '7d'
  control('bucket').value = 'day'
  runInNewContext(dashboard, {
    document, AbortController, AbortSignal, URLSearchParams, Event, Intl,
    fetch(path: string, init: RequestInit) {
      const pending = Promise.withResolvers<Response>()
      requests.push({ path, init, pending })
      return pending.promise
    },
  })
  return { control, requests,
    select(period: string) {
      control('period').value = period
      control('period').dispatchEvent(new Event('change'))
    },
    click(id: string) { control(id).dispatchEvent(new Event('click', { cancelable: true })) },
    params(index: number) { return new URL(requests[index].path, 'https://fixture.example/dashboard/').searchParams },
  }
}

function usage(sources: object[]) {
  return Response.json({ range, sources })
}

function details(rows: object[], nextPage: string | null = null) {
  return Response.json({ range, rows, nextPage })
}

describe('dashboard page', () => {
  test('shows an offline source with its last published usage and original timestamps', async () => {
    const ui = dashboardHarness()
    ui.requests[0].pending.resolve(usage([local, windows]))
    await Bun.sleep(0)
    expect(ui.requests[0]).toMatchObject({ path: '../api/usage?bucket=day&period=7d',
      init: { headers: { 'X-Magpie-Usage-Query': queryToken }, credentials: 'omit', redirect: 'error' },
    })
    const [center, remote] = ui.control('summary-rows').children
    expect(center.children[2].children[0].dateTime).toBe(range.from)
    expect(center.children.map(cell => cell.textContent).slice(3)).toEqual(['2', '11 / 12', '0 / 0', '0.00', '2'])
    expect(remote.children[1].textContent).toBe('暂失联')
    expect(remote.children[3].textContent).toBe('2')
    expect(ui.control('results').hidden).toBe(false)

    ui.requests[1].pending.resolve(details([row]))
    await Bun.sleep(0)
    const detail = ui.control('detail-rows').children[0]
    expect(detail.children[0].children[0].dateTime).toBe(row.t)
    expect(detail.children[1].textContent).toBe(windows.name)
    expect(detail.children[3].children[0].textContent).toBe('中间尝试')
    expect(detail.children[5].children[0].textContent).toBe('缓存计数未知')
    expect(detail.children[7].textContent).toBe('缺价')
  })

  test('preserves the latest period across late success and failure', async () => {
    const ui = dashboardHarness()
    ui.select('30d')
    ui.select('today')
    expect(ui.requests[0].init.signal?.aborted).toBe(true)
    ui.requests[0].pending.reject(new Error('synthetic late failure'))
    await Bun.sleep(0)
    expect(ui.control('results').attributes.get('aria-busy')).toBe('true')
    ui.requests[2].pending.resolve(usage([{ ...local, name: '今日结果' }]))
    await Bun.sleep(0)
    ui.requests[1].pending.resolve(usage([{ ...local, name: '迟到结果' }]))
    ui.requests[3].pending.resolve(details([]))
    await Bun.sleep(0)
    expect(ui.control('results').attributes.get('aria-busy')).toBe('false')
    expect(ui.control('summary-rows').children[0].children[0].textContent).toBe('今日结果')
  })

  test('pins detail paging to the matching source, unlabelled model and exact range', async () => {
    const ui = dashboardHarness()
    ui.requests[0].pending.resolve(usage([windows]))
    await Bun.sleep(0)
    ui.requests[1].pending.resolve(details([]))
    await Bun.sleep(0)
    ui.select('custom')
    ui.control('source').value = windows.id
    ui.control('via').value = 'through'
    ui.control('model').value = 'model:'
    ui.control('from').value = row.t
    ui.control('to').value = '2026-11-27T09:00:00+08:00'
    ui.click('refresh')
    expect(Object.fromEntries(ui.params(2))).toEqual({ sourceId: windows.id, bucket: 'day', via: 'through', model: '',
      from: ui.control('from').value, to: ui.control('to').value,
    })
    ui.requests[2].pending.resolve(usage([windows]))
    await Bun.sleep(0)
    ui.requests[3].pending.resolve(details([row], 'fixture-next-page'))
    await Bun.sleep(0)
    ui.click('next-rows')
    const filters = { sourceId: windows.id, via: 'through', model: '', from: range.from, to: range.to }
    expect(Object.fromEntries(ui.params(3))).toEqual(filters)
    expect(Object.fromEntries(ui.params(4))).toEqual({ ...filters, page: 'fixture-next-page' })
    ui.requests[4].pending.resolve(details([row]))
    await Bun.sleep(0)
    expect(ui.control('current-page').textContent).toBe('第 2 页')
    ui.click('previous-rows')
    expect(Object.fromEntries(ui.params(5))).toEqual(filters)
    ui.requests[5].pending.resolve(details([row], 'fixture-next-page'))
    await Bun.sleep(0)
    expect(ui.control('current-page').textContent).toBe('第 1 页')
  })

  test('recovers from a trend range limit by displaying totals and rows', async () => {
    const ui = dashboardHarness()
    ui.requests[0].pending.resolve(Response.json({ error: { code: 'bucket_range_too_large' } }, { status: 400 }))
    await Bun.sleep(0)
    expect(ui.params(1).has('bucket')).toBe(false)
    ui.requests[1].pending.resolve(usage([local]))
    await Bun.sleep(0)
    ui.requests[2].pending.resolve(details([]))
    await Bun.sleep(0)
    expect(ui.control('notice').textContent).toContain('上限')
    expect(ui.control('summary-rows').children[0].children[3].textContent).toBe('2')
    expect(ui.control('trend').hidden).toBe(true)
  })

  test('opens the dashboard after the service root sees the applied Options revision', async () => {
    const { control, document } = documentHarness()
    const revision = '11111111-1111-4111-8111-111111111111'
    let ready = false
    const navigations: string[] = []
    runInNewContext(diagnostics, {
      document, AbortSignal, URLSearchParams, setInterval: () => 1,
      location: { hash: `#revision=${revision}&view=dashboard`, replace: (path: string) => navigations.push(path) },
      fetch: async () => Response.json({ schema: 'magpie-usage-hub/status-v1', role: 'center', ready, phase: ready ? 'ready' : 'starting',
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

  test('shows sender recovery guidance with the last confirmed page and completed sync', async () => {
    const { control, document } = documentHarness()
    runInNewContext(diagnostics, {
      document, AbortSignal, URLSearchParams, Intl, setInterval: () => 1, location: { hash: '' },
      fetch: async () => Response.json({ schema: 'magpie-usage-hub/status-v1', role: 'sender', ready: true,
        phase: 'blocked', syncPhase: 'recovery_required', lastPageAt: observedAt, lastSyncedAt: observedAt,
        failure: { stage: 'source', code: 'source_recovery_required' },
      }),
    })
    await Bun.sleep(0)
    expect(control('runtime-heading').textContent).toBe('来源同步任务')
    expect(control('sync-phase').textContent).toContain('等待中心处理')
    expect(control('failure').textContent).toContain('确认同源重建')
    expect(control('last-page-row').hidden).toBe(false)
    expect(control('last-sync-row').hidden).toBe(false)
    expect(control('dashboard-link').hidden).toBe(true)
  })
})
