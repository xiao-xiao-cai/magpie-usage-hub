import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createIngest, maximumOtlpBodyBytes } from '../../src/center/ingest.ts'
import { type CenterLedger, openCenterLedger } from '../../src/center/ledger.ts'

const primaryKey = 'a'.repeat(64)
const secondKey = 'b'.repeat(64)
const traceId = '1234'.repeat(8)
const parentSpanId = 'afaf'.repeat(4)
const gatewaySpanId = '3344'.repeat(4)
const sessionSpanId = '4455'.repeat(4)
const startTime = '1795760000123456789'
const endTime = '1795760001234567890'
const ingestUrl = 'http://127.0.0.1/v1/traces'
const hidden = 'synthetic-sensitive-value'

function digest(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('hex')
}

function text(key: string, value: string) {
  return { key, value: { stringValue: value } }
}

function integer(key: string, value: string) {
  return { key, value: { intValue: value } }
}

function usage(input = '15', output = '9', cacheRead = '3', cacheWrite = '2', reasoning = '4') {
  return [
    integer('gen_ai.usage.input_tokens', input), integer('gen_ai.usage.output_tokens', output),
    integer('gen_ai.usage.cache_read.input_tokens', cacheRead),
    integer('gen_ai.usage.cache_creation.input_tokens', cacheWrite),
    integer('gen_ai.usage.reasoning.output_tokens', reasoning),
  ]
}

function generation(attributes: (ReturnType<typeof text> | ReturnType<typeof integer>)[] = usage()) {
  return { traceId, spanId: gatewaySpanId, parentSpanId, kind: 3, flags: 1,
    startTimeUnixNano: startTime, endTimeUnixNano: endTime, status: { code: 0 },
    attributes: [text('langfuse.observation.type', 'generation'), text('gen_ai.request.model', 'sdk-fixture'),
      integer('http.response.status_code', '200'), ...attributes],
  }
}

function message(spans: unknown[]) {
  return { resourceSpans: [{ resource: { attributes: [text('host.name', hidden)] }, scopeSpans: [
    { scope: { name: 'github.com/yetone/magpie' }, spans },
    { scope: { name: 'other.sdk' }, spans: [{ ...generation(), spanId: 'cdef'.repeat(4) }] },
  ] }] }
}

function post(body: string | ReadableStream<Uint8Array>, key: string | null = primaryKey, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (key !== null) headers.set('Authorization', `Bearer ${key}`)
  return new Request(ingestUrl, { method: 'POST', body, headers })
}

function createSource(ledger: CenterLedger, name: string, key: string) {
  const { revision } = ledger.managementSnapshot()
  const { sources } = ledger.editSource({ revision, action: 'create', name, digest: digest(key), enabled: true })
  const source = sources.find(value => value.name === name)
  if (!source) throw new Error('fixture source missing')
  return source.id
}

test('stock trace envelope commits only generation usage and deduplicates a retry per source', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    const sourceId = createSource(ledger, 'fixture-source', primaryKey)
    const secondId = createSource(ledger, 'fixture-second', secondKey)
    const receive = createIngest(ledger)
    const gateway = generation([...usage(), text('langfuse.observation.cost_details', '{"input":0,"output":0,"total":0}'),
      text('langfuse.observation.input', hidden), text('langfuse.observation.output', hidden),
      text('magpie.gateway_key.name', hidden), text('langfuse.trace.name', hidden)])
    const session = { ...generation(usage('0', '0', '0', '0', '0')), kind: 1, spanId: sessionSpanId,
      endTimeUnixNano: startTime }
    session.attributes.push(text('langfuse.session.id', hidden), text('magpie.timing.source', 'recorded'))
    const bare = { ...gateway, spanId: '5566'.repeat(4), parentSpanId: undefined,
      attributes: gateway.attributes.filter(attribute => attribute.key !== 'langfuse.observation.type') }
    const tool = { ...session, spanId: '6677'.repeat(4), attributes: [text('langfuse.observation.type', 'tool')] }
    const root = { ...gateway, kind: 2, spanId: parentSpanId }
    const generationWithoutUsage = { ...session, spanId: '7788'.repeat(4),
      attributes: [text('langfuse.observation.type', 'generation'), text('langfuse.session.id', hidden)] }
    const body = JSON.stringify(message([gateway, session, root, tool, bare, generationWithoutUsage]))

    const response = await receive(post(body))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
    expect((await receive(post(body))).status).toBe(200)
    expect((await receive(post(body, secondKey))).status).toBe(200)

    const rows = ledger.db.query<Record<string, string | number | null>, []>(`SELECT source_id, row_key, t, via, model, input, output, cache_read,
      cache_write, reasoning, cost, status, duration_ms FROM usage_rows ORDER BY via`).all()
    expect(rows).toHaveLength(4)
    expect(rows.filter(row => row.source_id === sourceId)).toEqual([
      { source_id: sourceId, row_key: digest(`${traceId}:${sessionSpanId}`), t: '2026-11-27T06:13:20.123456789Z',
        via: 'session', model: 'sdk-fixture', input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0,
        cost: null, status: null, duration_ms: 0 },
      { source_id: sourceId, row_key: digest(`${traceId}:${gatewaySpanId}`), t: '2026-11-27T06:13:20.123456789Z',
        via: 'through', model: 'sdk-fixture', input: 10, output: 9, cache_read: 3, cache_write: 2, reasoning: 4,
        cost: 0, status: 200, duration_ms: 1111 },
    ])
    expect(rows.filter(row => row.source_id === secondId)).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain(hidden)
  } finally { ledger.db.close() }
})

test('authentication and the JSON/body boundary reject malformed input before writing', async () => {
  const ledger = openCenterLedger(':memory:')
  try {
    createSource(ledger, 'fixture-source', primaryKey)
    const receive = createIngest(ledger)
    const totalRows = () => ledger.db.query('SELECT row_key FROM usage_rows').all().length
    const valid = generation()
    const unsupported = await receive(post('{}', primaryKey, { 'Content-Type': 'application/x-protobuf' }))
    expect(unsupported.status).toBe(415)
    expect((await receive(post('{}', primaryKey, { 'Content-Encoding': 'gzip' }))).status).toBe(415)
    expect((await receive(post('{', null))).status).toBe(401)
    expect((await receive(post('{', secondKey))).status).toBe(401)
    expect((await receive(new Request(ingestUrl))).status).toBe(405)
    expect((await receive(new Request('http://127.0.0.1/v1/usage-hub/checkpoint'))).status).toBe(404)
    expect((await receive(post('{}', primaryKey, { 'Content-Length': `${maximumOtlpBodyBytes + 1}` }))).status).toBe(413)
    const oversized = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(maximumOtlpBodyBytes + 1))
      controller.close()
    } })
    expect((await receive(post(oversized))).status).toBe(413)

    const invalid = [
      { ...valid, traceId: '0'.repeat(32) },
      { ...valid, spanId: 'not-a-span' },
      { ...valid, parentSpanId: '0'.repeat(16) },
      { ...valid, endTimeUnixNano: '1' },
      { ...valid, startTimeUnixNano: '9999999999999999999' },
      generation(usage('3', '7', '4', '0')),
      generation(usage('-1', '7', '0', '0')),
      generation(usage('9007199254740992')),
      generation(usage().filter(attribute => attribute.key !== 'gen_ai.usage.output_tokens')),
      generation([...usage(), text('langfuse.observation.cost_details', `{"total":"${hidden}"}`)]),
    ]
    for (const span of invalid) {
      const response = await receive(post(JSON.stringify(message([span]))))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: { code: 'invalid_otlp_traces' } })
      expect(totalRows()).toBe(0)
    }
    const partial = await receive(post(JSON.stringify(message([valid, ...invalid]))))
    expect(partial.status).toBe(200)
    expect(await partial.json()).toEqual({ partialSuccess: { rejectedSpans: String(invalid.length) } })
    expect(totalRows()).toBe(1)
  } finally { ledger.db.close() }
})

test('slow uploads are limited by source and a reassigned key cannot finish an in-flight commit', async () => {
  const ledger = openCenterLedger(':memory:')
  const upload = Promise.withResolvers<void>()
  const pending: Promise<Response>[] = []
  try {
    const source = createSource(ledger, 'fixture-source', primaryKey)
    createSource(ledger, 'fixture-second', secondKey)
    const receive = createIngest(ledger)
    const body = JSON.stringify(message([generation()]))
    const delayed = () => new ReadableStream<Uint8Array>({ async pull(controller) {
      await upload.promise
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    } })
    pending.push(receive(post(delayed())), receive(post(delayed())))
    expect((await receive(post(body))).status).toBe(429)
    expect((await receive(post(body, secondKey))).status).toBe(200)
    ledger.editSource({ revision: ledger.managementSnapshot().revision, action: 'revoke', id: source, slot: 'all' })
    createSource(ledger, 'fixture-replacement', primaryKey)
    upload.resolve()
    for (const response of await Promise.all(pending)) {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: { code: 'source_mismatch' } })
    }
    expect(ledger.db.query('SELECT source_id FROM usage_rows').all()).toHaveLength(1)
  } finally {
    upload.resolve()
    await Promise.all(pending)
    ledger.db.close()
  }
})

test('a storage failure returns a sanitized retryable response', async () => {
  const receive = createIngest({ authenticateOtlp: () => 'fixture-source', commitOtlp: () => { throw new Error(hidden) } })
  const response = await receive(post(JSON.stringify(message([generation()]))))
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: { code: 'ingest_unavailable' } })
})
