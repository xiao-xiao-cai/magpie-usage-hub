import { expect, test } from 'bun:test'
import { requestDirect } from '../../src/gateway/direct.ts'

test('direct transport preserves UTF-8 posts, statuses, headers and manual redirects', async () => {
  const body = JSON.stringify({ model: '测试模型' })
  let reported: { method: string; key: string | null; bytes: string | null; body: string } | undefined
  let followed = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/redirect') return Response.redirect(new URL('/target', url), 307)
    if (url.pathname === '/target') {
      followed += 1
      return new Response(null, { status: 204 })
    }
    reported = {
      method: request.method, key: request.headers.get('authorization'),
      bytes: request.headers.get('content-length'), body: await request.text(),
    }
    return Response.json({ code: 'rate_limited' }, { status: 429, headers: { 'retry-after': '31' } })
  } })
  try {
    const init = { method: 'POST', body, headers: { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' } } as const
    const response = await requestDirect(server.url, init, AbortSignal.timeout(1_000))
    expect(reported).toEqual({ method: 'POST', key: 'Bearer fixture-key', bytes: String(Buffer.byteLength(body)), body })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('31')
    expect(await response.json()).toEqual({ code: 'rate_limited' })

    const redirect = await requestDirect(new URL('/redirect', server.url), init, AbortSignal.timeout(1_000))
    expect(redirect.status).toBe(307)
    await redirect.body?.cancel()
    expect(followed).toBe(0)

    const empty = await requestDirect(new URL('/target', server.url), { method: 'GET' }, AbortSignal.timeout(1_000))
    expect(empty.status).toBe(204)
    expect(empty.body).toBeNull()
  } finally {
    await server.stop(true)
  }
})

test('direct request timeout also aborts a response stalled after headers', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')) },
    }))
  } })
  const signal = AbortSignal.timeout(250)
  try {
    const response = await requestDirect(server.url, { method: 'GET' }, signal)
    expect(response.status).toBe(200)
    await expect(response.json()).rejects.toThrow()
    expect(signal.aborted).toBe(true)
  } finally {
    await server.stop(true)
  }
})
