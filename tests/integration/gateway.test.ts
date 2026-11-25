import { describe, expect, test } from 'bun:test'
import { GatewayFailure, postUsageBatch, readGatewayPid, readUsagePage } from '../../src/gateway/client.ts'
import { type ReportRow } from '../../src/sync/mapping.ts'
import { reportPage } from '../../src/sync/page.ts'

const expectedRids = ['synthetic-rid-a', 'synthetic-rid-b']
const batchBody = JSON.stringify(expectedRids.map((rid) => ({ rid })))
const timeoutMs = 2000

function listen(fetch: (request: Request) => Response | Promise<Response>) {
  return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch })
}

describe('source gateway', () => {
  test('reads the PID from the native gateway root', async () => {
    const server = listen((request) => {
      expect(request.method).toBe('GET')
      expect(new URL(request.url).pathname).toBe('/')
      return Response.json({ name: 'magpie', pid: 4321 })
    })
    try {
      expect(await readGatewayPid(server.url, timeoutMs)).toBe(4321)
    } finally {
      await server.stop(true)
    }
  })

  test.each([
    { name: 'other', pid: 4321 }, { name: 'magpie' }, { name: 'magpie', pid: '4321' },
    { name: 'magpie', pid: 0 }, { name: 'magpie', pid: 1.5 },
  ])('rejects malformed gateway identity %j', async (payload) => {
    const server = listen(() => Response.json(payload))
    try {
      await expect(readGatewayPid(server.url, timeoutMs)).rejects.toMatchObject({
        stage: 'source', code: 'invalid_gateway_identity',
      })
    } finally {
      await server.stop(true)
    }
  })

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

  test.each(['', ' ', ' start ', 'now', 'start', ' opaque '])('refuses an unusable next cursor %j', async (nextCursor) => {
    const server = listen(() => Response.json({ rows: [], deleted: [], next_cursor: nextCursor, has_more: false }))
    try {
      await expect(readUsagePage(server.url, 'start', 'caller-a', timeoutMs)).rejects.toMatchObject({
        stage: 'source', code: 'invalid_source_page',
      })
    } finally {
      await server.stop(true)
    }
  })

  test.each([
    [400, 'cursor_invalid', 'cursor_invalid'],
    [400, 'cursor_filter_changed', 'cursor_filter_changed'],
    [410, 'cursor_reset', 'cursor_reset'],
    [410, 'cursor_expired', 'cursor_expired'],
    [410, 'cursor_invalid', 'http_error'],
    [400, 'cursor_reset', 'http_error'],
    [400, 'other', 'http_error'],
  ])('classifies HTTP %i and feed code %s', async (status, feedCode, code) => {
    const server = listen(() => Response.json({
      error: { code: feedCode, type: 'invalid_request_error', message: 'synthetic private error body' },
    }, { status }))
    try {
      await expect(readUsagePage(server.url, 'old', 'caller-a', timeoutMs)).rejects.toMatchObject({
        stage: 'source', code, message: code, httpStatus: status,
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

  test.each([
    [400, 'http_error'], [401, 'unauthorized'], [403, 'unauthorized'], [404, 'gateway_unavailable'],
    [405, 'gateway_unavailable'], [413, 'batch_too_large'], [500, 'upstream_failure'],
  ])('exposes a controlled failure for HTTP %i', async (status, code) => {
    const server = listen(() => new Response('synthetic private error body', { status }))
    try {
      await expect(postUsageBatch(server.url, 'synthetic-report-key', batchBody, expectedRids, timeoutMs))
        .rejects.toMatchObject({ stage: 'center', code, message: code, httpStatus: status })
    } finally {
      await server.stop(true)
    }
  })

  test.each([['13', 13_000], ['0', 0], ['2.5', undefined]])('interprets Retry-After %s on rate limiting', async (header, delay) => {
    const server = listen(() => new Response(null, { status: 429, headers: { 'Retry-After': header } }))
    try {
      await expect(postUsageBatch(server.url, 'synthetic-report-key', batchBody, expectedRids, timeoutMs))
        .rejects.toMatchObject({ stage: 'center', code: 'rate_limited', httpStatus: 429, retryAfterMs: delay })
    } finally {
      await server.stop(true)
    }
  })

  test('reads a Retry-After date on service unavailability', async () => {
    const header = new Date(Date.now() + 60_000).toUTCString()
    const retryAt = Date.parse(header)
    const server = listen(() => new Response(null, { status: 503, headers: { 'Retry-After': header } }))
    try {
      const startedAt = Date.now()
      const error: unknown = await postUsageBatch(server.url, 'synthetic-report-key', batchBody, expectedRids, timeoutMs)
        .catch((failure: unknown) => failure)
      expect(error).toMatchObject({ stage: 'center', code: 'upstream_failure', httpStatus: 503 })
      if (!(error instanceof GatewayFailure)) throw new Error('expected gateway failure')
      expect(error.retryAfterMs).toBeGreaterThanOrEqual(retryAt - Date.now())
      expect(error.retryAfterMs).toBeLessThanOrEqual(retryAt - startedAt)
    } finally {
      await server.stop(true)
    }
  })
})

function reportRows(count: number): ReportRow[] {
  return Array.from({ length: count }, (_, index) => ({
    t: '2026-11-25T02:30:00Z', agent: 'fixture-agent', provider: 'fixture-provider', model: 'fixture-model',
    status: 200, rid: `fixture-rid-${index}`,
  }))
}

describe('page reporting', () => {
  test('bisects rejected sub-batches in original order and counts every receipt', async () => {
    const rows = reportRows(203)
    const expectedBatches = [
      rows.slice(0, 200), rows.slice(200), rows.slice(200, 201), rows.slice(201), rows.slice(201, 202), rows.slice(202),
    ]
    let requests = 0
    const server = listen(async (request) => {
      const batch = expectedBatches[requests]
      const body = await request.text()
      expect(body).toBe(JSON.stringify(batch))
      requests += 1
      if (batch.length === 2 || batch.length === 3) return new Response(null, { status: 413 })
      return Response.json({
        accepted: batch.length - 1,
        skipped: 1,
        records: batch.map(({ rid }, index) => ({ index, rid, status: index === 0 ? 'skipped' : 'accepted' })),
      })
    })
    try {
      expect(await reportPage(server.url, 'synthetic-report-key', rows, 'after', timeoutMs))
        .toEqual({ nextCursor: 'after', accepted: 199, skipped: 4 })
      expect(requests).toBe(expectedBatches.length)
    } finally {
      await server.stop(true)
    }
  })

  test('rejects the page when one row still receives 413', async () => {
    const rows = reportRows(2)
    const bodies: string[] = []
    const server = listen(async (request) => {
      bodies.push(await request.text())
      return new Response(null, { status: 413 })
    })
    try {
      await expect(reportPage(server.url, 'synthetic-report-key', rows, 'after', timeoutMs))
        .rejects.toMatchObject({ stage: 'center', code: 'batch_too_large', httpStatus: 413 })
      expect(bodies).toEqual([JSON.stringify(rows), JSON.stringify(rows.slice(0, 1))])
    } finally {
      await server.stop(true)
    }
  })
})
