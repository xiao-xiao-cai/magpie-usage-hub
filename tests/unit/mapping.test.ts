import { expect, test } from 'bun:test'
import { MappingFailure, mapUsageRow, splitUsageBatches } from '../../src/sync/mapping.ts'

const sourceId = '3281b219-d4a8-4bf6-8b2f-0da52e3dba86'
const callerKeyId = 'fixture-caller'
const sourceRow = {
  origin: 'gateway',
  callerKeyId,
  id: 'abc',
  seq: 1,
  t: '2026-11-25T12:34:56.987654321+08:00',
  agent: 'fixture-agent',
  provider: 'fixture-provider',
  model: 'fixture-model',
  in: 3,
  out: 2,
  ms: 75,
  status: 200,
  priced: true,
  cost: 0,
  providerAccount: 'fixture-account',
  original_ids: { request_id: 'fixture-vendor-id', session_id: 'fixture-session' },
  err: 'fixture-raw-error',
}

function map(overrides: Record<string, unknown> = {}) {
  return mapUsageRow({ ...sourceRow, ...overrides }, sourceId, callerKeyId)
}

function report(overrides: Record<string, unknown> = {}) {
  const row = map(overrides)
  if (!row) throw new Error('expected a mapped row')
  return row
}

test('maps approved fields with the original time and stable ID', () => {
  expect(report()).toEqual({
    t: sourceRow.t,
    agent: sourceRow.agent,
    provider: sourceRow.provider,
    model: sourceRow.model,
    in: 3,
    out: 2,
    ms: 75,
    status: 200,
    cost: 0,
    rid: `mpu1.${sourceId}.ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`,
  })
  expect(report({ id: 'def' }).rid).not.toBe(report().rid)
})

test('excludes other origins and shared rows and rejects out-of-scope gateway rows', () => {
  expect(map({ origin: 'session', id: undefined })).toBeNull()
  expect(map({ origin: 'reported' })).toBeNull()
  expect(map({ computer: 'fixture-remote' })).toBeNull()
  expect(() => map({ callerKeyId: 'another-caller' })).toThrow('unexpected_caller_key')
  expect(() => map({ callerKeyId: undefined, callerKey: callerKeyId })).toThrow('unexpected_caller_key')
  expect(() => map({ id: '' })).toThrow('invalid_row_id')
})

test('preserves known usage and only emits the controlled cancellation reason', () => {
  expect(report({ priced: false, cost: 42 })).not.toHaveProperty('cost')
  expect(report({ priced: true, cost: 0.012 })).toHaveProperty('cost', 0.012)
  expect(report({ cache_read: 0 })).toHaveProperty('cache_read', 0)
  expect(report({ cache_read: 0, cache_unknown: true })).not.toHaveProperty('cache_read')
  expect(report({ status: 499 })).not.toHaveProperty('err')
  expect(report({ status: 499, canceled: true })).toHaveProperty('err', 'the agent canceled the request')
})

test.each([
  [{ status: 600 }, 'invalid_status'],
  [{ in: 100_000_001 }, 'invalid_in'],
  [{ out: 0.5 }, 'invalid_out'],
  [{ cache_write: 4, cache_write_1h: 5 }, 'invalid_cache_write_1h'],
  [{ ms: 86_400_001 }, 'invalid_ms'],
  [{ ms: 75, first_text_ms: 76 }, 'invalid_first_text_ms'],
  [{ ms: 75, ttft_ms: 62, first_text_ms: 61 }, 'invalid_first_text_ms'],
  [{ ms: 75, flow_ms: 95 }, 'invalid_flow_ms'],
  [{ priced: true, cost: undefined }, 'invalid_cost'],
  [{ priced: true, cost: 10_001 }, 'invalid_cost'],
  [{ model: 'a\u0000b' }, 'invalid_model'],
  [{ agent: '客'.repeat(257) }, 'invalid_agent'],
  [{ t: '2026-02-30T08:00:00Z' }, 'invalid_t'],
  [{ t: '2000-01-01T00:00:00+01:00' }, 'invalid_t'],
  [{ t: '2026-11-25T01:00:00' }, 'invalid_t'],
] as const)('rejects an invalid report field %#', (overrides, code) => {
  expect(() => report(overrides)).toThrow(code)
})

test('splits JSON arrays at 200 rows and preserves receipt order', () => {
  const rows = Array.from({ length: 201 }, (_, index) => report({ id: `fixture-${index}` }))
  const batches = splitUsageBatches(rows)
  expect(splitUsageBatches([])).toEqual([])
  expect(batches.map(batch => batch.rids.length)).toEqual([200, 1])
  expect(batches.flatMap(batch => batch.rids)).toEqual(rows.map(row => row.rid))
  expect(batches.flatMap(batch => JSON.parse(batch.body))).toEqual(rows)
})

test('caps each UTF-8 array at 1 MiB including brackets and commas', () => {
  const text = '🪶'.repeat(256)
  const rows = Array.from({ length: 190 }, (_, index) => report({
    id: `fixture-${index}`,
    agent: text,
    provider: text,
    model: text,
    req: text,
    served: text,
    effort: text,
  }))
  const batches = splitUsageBatches(rows)
  expect(batches).toHaveLength(2)
  for (const batch of batches) {
    expect(new TextEncoder().encode(batch.body).byteLength).toBeLessThanOrEqual(1024 * 1024)
  }
  expect(batches.flatMap(batch => JSON.parse(batch.body))).toEqual(rows)
  expect(() => splitUsageBatches([{ ...report(), model: 'a'.repeat(1024 * 1024) }])).toThrow(MappingFailure)
})
