import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { createDiagnostics, serveDiagnostics, updateDiagnosticProgress } from '../../src/diagnostics.ts'
import type { SyncState } from '../../src/state/store.ts'

const revision = 'b02166b2-07f4-4208-aa01-8dfb9acf244e'
const from = '2026-02-01T01:00:00.000Z'
const to = '2026-02-01T02:00:00.000Z'
const binding = {
  sourceGatewayUrl: 'http://127.0.0.1:7000/',
  sourceCallerKeyId: 'fixture-caller-id',
  centralGatewayUrl: 'https://fixture-private-center.example/',
  initialMode: 'now',
} as const

test('the loopback status service exposes a read-only summary of committed recovery progress', async () => {
  const diagnostics = createDiagnostics(revision, true)
  const state: SyncState = {
    version: 2,
    sourceInstanceId: 'd71370b8-945f-4042-8ae6-ef2364e75d0c',
    binding,
    cursor: 'fixture-daily-cursor',
    lastConfirmedAt: from,
    recovery: {
      active: {
        request: { id: 'bc2d5f3c-8157-474c-ab9e-15f3c08403ce', binding, kind: 'range', from, to },
        cursor: 'fixture-scan-cursor', pages: 2, accepted: 3, skipped: 1, lastConfirmedAt: to,
      },
      results: [],
    },
  }
  diagnostics.update({ phase: 'retrying', appliedRevision: revision,
    failure: { stage: 'center', code: 'upstream_failure', httpStatus: 503 },
    lastPage: { kind: 'recovery', accepted: 2, skipped: 1, hasMore: true },
  })
  updateDiagnosticProgress(diagnostics, state)
  const server = serveDiagnostics(diagnostics, 0)
  try {
    const page = await fetch(server.url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('用量同步诊断')
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'")
    const url = new URL('api/status', server.url)
    const response = await fetch(url, { headers: { Origin: 'null' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('null')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const serialized = await response.text()
    expect(JSON.parse(serialized)).toMatchObject({
      loadedRevision: revision, appliedRevision: revision, credentialConfigured: true,
      lastConfirmedAt: to, failure: { stage: 'center', code: 'upstream_failure', httpStatus: 503 },
      recovery: { status: 'running', kind: 'range', pages: 2, accepted: 3, skipped: 1, from, to },
    })
    for (const secret of ['fixture-', state.sourceInstanceId, state.recovery?.active?.request.id]) {
      if (secret) expect(serialized).not.toContain(secret)
    }
    const write = await fetch(url, { method: 'POST' })
    expect(write.status).toBe(405)
    expect(write.headers.get('allow')).toBe('GET')
    expect((await fetch(url, { headers: { Origin: 'https://fixture-unrelated.example' } })).status).toBe(403)
    expect((await fetch(new URL('state.json', server.url))).status).toBe(404)
  } finally {
    await server.stop(true)
  }
})

test('diagnostic refresh ignores stale failures and hides status from a different revision', async () => {
  const elements = new Map<string, { textContent: string; hidden: boolean }>()
  const requests: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  let refresh: (() => Promise<void>) | undefined
  const status = createDiagnostics(revision, false)
  status.update({ phase: 'idle', appliedRevision: revision })
  runInNewContext(await Bun.file(new URL('../../ui/status.js', import.meta.url)).text(), {
    document: {
      getElementById(id: string) {
        const cached = elements.get(id)
        if (cached) return cached
        const element = {
          textContent: '', hidden: false,
          addEventListener(_event: string, callback: () => Promise<void>) { refresh = callback },
        }
        elements.set(id, element)
        return element
      },
    },
    fetch() {
      const request = Promise.withResolvers<Response>()
      requests.push(request)
      return request.promise
    },
    location: { hash: `#revision=${revision}` },
    setInterval() {},
    AbortSignal,
    URLSearchParams,
  })
  if (!refresh) throw new Error('refresh handler not installed')
  const earlier = refresh()
  const latest = refresh()
  requests[1].reject(new Error('fixture error'))
  await earlier
  expect(elements.get('notice')?.textContent).toBe('正在读取后台状态…')
  requests[2].resolve(Response.json(status.getStatus()))
  await latest
  requests[0].reject(new Error('fixture error'))
  await Bun.sleep(0)
  expect(elements.get('notice')?.textContent).toBe('后台已采用从配置页打开时的修订。')
  expect(elements.get('status')?.hidden).toBe(false)

  const differentRevision = refresh()
  const differentStatus = createDiagnostics('5c8f1dab-d60a-4325-a95d-695559540b9a', true)
  differentStatus.update({ phase: 'blocked' })
  requests[3].resolve(Response.json(differentStatus.getStatus()))
  await differentRevision
  expect(elements.get('status')?.hidden).toBe(true)
  expect(elements.get('notice')?.textContent).toContain('与配置页保存修订一致')
  expect(elements.get('phase')?.textContent).toBe('等待下次轮询')
})
