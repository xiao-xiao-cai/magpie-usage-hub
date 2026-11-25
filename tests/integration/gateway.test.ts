import { describe, expect, test } from 'bun:test'
import { postUsageBatch, readUsagePage } from '../../src/gateway/client.ts'

const expectedRids = ['synthetic-rid-a', 'synthetic-rid-b']
const batchBody = JSON.stringify(expectedRids.map((rid) => ({ rid })))
const timeoutMs = 2000

function listen(fetch: (request: Request) => Response | Promise<Response>) {
  return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch })
}

describe('source gateway', () => {
  test('requests the exact opaque cursor and test caller filter on the native feed', async () => {
    const requests: unknown[] = []
    const server = listen((request) => {
      const url = new URL(request.url)
      requests.push({
        method: request.method,
        authorization: request.headers.get('authorization'),
        pathname: url.pathname,
        params: Object.fromEntries(url.searchParams),
      })
      return Response.json({
        rows: [{ id: 'synthetic-source-row' }],
        deleted: [{ id: 'synthetic-deleted-row', seq: 2 }],
        next_cursor: 'next/+%=',
        has_more: true,
      })
    })
    try {
      const page = await readUsagePage(server.url, 'cursor/+%=&', 'caller/&+', timeoutMs)
      expect(page).toEqual({
        rows: [{ id: 'synthetic-source-row' }],
        deletedCount: 1,
        nextCursor: 'next/+%=',
        hasMore: true,
      })
      expect(requests).toEqual([{
        method: 'GET',
        authorization: null,
        pathname: '/v1/magpie/usage/requests',
        params: { cursor: 'cursor/+%=&', callerKey: 'caller/&+', via: 'through', limit: '500' },
      }])
    } finally {
      await server.stop(true)
    }
  })

  test('rejects malformed page data before exposing a cursor', async () => {
    const server = listen(() => Response.json({
      rows: [], deleted: [{ id: 'synthetic-deleted-row', seq: '2' }], next_cursor: 'next', has_more: false,
    }))
    try {
      await expect(readUsagePage(server.url, 'now', 'caller-a', timeoutMs)).rejects.toMatchObject({
        stage: 'source', code: 'invalid_source_page',
      })
    } finally {
      await server.stop(true)
    }
  })

  test('times out while reading a response body', async () => {
    let bodyStarted = false
    const server = listen(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        bodyStarted = true
        controller.enqueue(new TextEncoder().encode('{"rows":['))
      },
    })))
    try {
      await expect(readUsagePage(server.url, 'now', 'caller-a', 250)).rejects.toMatchObject({
        stage: 'source', code: 'timeout',
      })
      expect(bodyStarted).toBe(true)
    } finally {
      await server.stop(true)
    }
  })
})

describe('center gateway', () => {
  const accepted = { index: 0, rid: expectedRids[0], status: 'accepted' }
  const skipped = { index: 1, rid: expectedRids[1], status: 'skipped' }

  test('sends the exact JSON bearer request and confirms accepted and skipped items', async () => {
    const requests: unknown[] = []
    const server = listen(async (request) => {
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        authorization: request.headers.get('authorization'),
        contentType: request.headers.get('content-type'),
        body: await request.text(),
      })
      return Response.json({ accepted: 1, skipped: 1, records: [accepted, skipped] })
    })
    try {
      expect(await postUsageBatch(server.url, 'synthetic-report-key', batchBody, expectedRids, timeoutMs))
        .toEqual({ accepted: 1, skipped: 1 })
      expect(requests).toEqual([{
        path: '/v1/magpie/usage/requests', method: 'POST', authorization: 'Bearer synthetic-report-key',
        contentType: 'application/json', body: batchBody,
      }])
    } finally {
      await server.stop(true)
    }
  })

  test.each([
    ['missing item', { accepted: 1, skipped: 0, records: [accepted] }],
    ['duplicate item', { accepted: 2, skipped: 0, records: [accepted, accepted] }],
    ['wrong rid', { accepted: 1, skipped: 1, records: [accepted, { ...skipped, rid: accepted.rid }] }],
    ['wrong totals', { accepted: 0, skipped: 2, records: [accepted, skipped] }],
    ['unknown status', { accepted: 1, skipped: 1, records: [accepted, { ...skipped, status: 'retry' }] }],
  ])('rejects an incomplete acknowledgment: %s', async (_caseName, payload) => {
    const server = listen(() => Response.json(payload))
    try {
      await expect(postUsageBatch(server.url, 'synthetic-report-key', batchBody, expectedRids, timeoutMs))
        .rejects.toMatchObject({ stage: 'center', code: 'invalid_receipt' })
    } finally {
      await server.stop(true)
    }
  })

  test('refuses a redirect before the destination sees a request', async () => {
    let redirectedRequests = 0
    const server = listen((request) => {
      const url = new URL(request.url)
      if (url.pathname === '/forward') {
        redirectedRequests += 1
        return new Response(null, { status: 204 })
      }
      return Response.redirect(new URL('/forward', url), 307)
    })
    try {
      await expect(postUsageBatch(server.url, 'synthetic-report-key', batchBody, expectedRids, timeoutMs))
        .rejects.toMatchObject({ stage: 'center', code: 'redirect_refused', httpStatus: 307 })
      expect(redirectedRequests).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

  test('exposes only a controlled failure and status on rejection', async () => {
    const server = listen(() => new Response('synthetic private error body', { status: 403 }))
    try {
      await expect(postUsageBatch(server.url, 'synthetic-report-key', batchBody, expectedRids, timeoutMs))
        .rejects.toMatchObject({ stage: 'center', code: 'http_error', message: 'http_error', httpStatus: 403 })
    } finally {
      await server.stop(true)
    }
  })
})
