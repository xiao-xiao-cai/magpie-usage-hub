import { createHash } from 'node:crypto'
import type { UsageRow as UpsertRow } from '../sync/protocol.ts'
import { isRecord } from './http.ts'

export type OtlpRow = Omit<UpsertRow, 'seq' | 'via'> & { via: 'through' | 'session' }

const magpieScope = 'github.com/yetone/magpie'
const maximumGroups = 128
const maximumSpans = 128
const maximumAttributes = 128
const maximumTimestamp = 9223372036854775807n
const nanosPerSecond = 1_000_000_000n
const nanosPerMillisecond = 1_000_000n
const traceIdPattern = /^[a-f0-9]{32}$/iu
const spanIdPattern = /^[a-f0-9]{16}$/iu
const decimalPattern = /^(?:0|[1-9][0-9]*)$/u
const fields = {
  observation: 'langfuse.observation.type',
  session: 'langfuse.session.id',
  model: 'gen_ai.request.model',
  input: 'gen_ai.usage.input_tokens',
  output: 'gen_ai.usage.output_tokens',
  cacheRead: 'gen_ai.usage.cache_read.input_tokens',
  cacheWrite: 'gen_ai.usage.cache_creation.input_tokens',
  reasoning: 'gen_ai.usage.reasoning.output_tokens',
  cost: 'langfuse.observation.cost_details',
  status: 'http.response.status_code',
} as const
const allowedAttributes = new Set<string>(Object.values(fields))

export class OtlpParseFailure extends Error {
  constructor() { super('invalid_otlp_traces') }
}

function invalidTraces(): never {
  throw new OtlpParseFailure()
}

function readAttributes(value: unknown): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > maximumAttributes) return invalidTraces()
  const attributes = new Map<string, Record<string, unknown>>()
  for (const attribute of value) {
    if (!isRecord(attribute) || typeof attribute.key !== 'string') return invalidTraces()
    if (!allowedAttributes.has(attribute.key)) continue
    if (attributes.has(attribute.key) || !isRecord(attribute.value)) return invalidTraces()
    attributes.set(attribute.key, attribute.value)
  }
  return attributes
}

function validId(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value) && /[^0]/u.test(value)
}

function readCount(value: unknown): number {
  if (typeof value !== 'string' || value.length > 16 || !decimalPattern.test(value)) return invalidTraces()
  const count = Number(value)
  if (!Number.isSafeInteger(count)) return invalidTraces()
  return count
}

function readNanos(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 19 || !decimalPattern.test(value)) return invalidTraces()
  const nanos = BigInt(value)
  if (nanos === 0n || nanos > maximumTimestamp) return invalidTraces()
  return nanos
}

function formatTimestamp(nanos: bigint): string {
  const seconds = new Date(Number(nanos / nanosPerSecond) * 1000).toISOString().slice(0, 19)
  const fraction = (nanos % nanosPerSecond).toString().padStart(9, '0')
  return `${seconds}.${fraction}Z`
}

function readCost(value: unknown): number {
  if (typeof value !== 'string' || value.length > 256) return invalidTraces()
  let cost: unknown
  try { cost = JSON.parse(value) } catch { return invalidTraces() }
  if (!isRecord(cost) || typeof cost.total !== 'number' || !Number.isFinite(cost.total)
    || cost.total < 0 || cost.total > Number.MAX_SAFE_INTEGER) return invalidTraces()
  return cost.total
}

function readStatus(value: unknown): number | null {
  if (value === undefined) return null
  const status = readCount(value)
  if (status === 0) return null
  if (status < 100 || status > 599) return invalidTraces()
  return status
}

function readSpan(value: unknown): OtlpRow | null {
  if (!isRecord(value)) return invalidTraces()
  if (value.kind !== 1 && value.kind !== 3) return null
  const attributes = readAttributes(value.attributes)
  if (attributes.get(fields.observation)?.stringValue !== 'generation') return null
  if (!attributes.has(fields.input) && !attributes.has(fields.output)) return null

  const session = attributes.get(fields.session)?.stringValue
  let via: OtlpRow['via']
  if (value.kind === 1 && typeof session === 'string' && session !== '') via = 'session'
  else if (value.kind === 3 && !attributes.has(fields.session)) {
    if (!validId(value.parentSpanId, spanIdPattern)) return invalidTraces()
    via = 'through'
  }
  else return null

  const { traceId, spanId } = value
  const model = attributes.get(fields.model)?.stringValue
  if (!validId(traceId, traceIdPattern) || !validId(spanId, spanIdPattern)
    || typeof model !== 'string' || model.length > 512 || /[\u0000-\u001f\u007f]/u.test(model)) return invalidTraces()

  const start = readNanos(value.startTimeUnixNano)
  const end = readNanos(value.endTimeUnixNano)
  if (end < start) return invalidTraces()

  const totalInput = readCount(attributes.get(fields.input)?.intValue)
  const output = readCount(attributes.get(fields.output)?.intValue)
  const cacheRead = readCount(attributes.get(fields.cacheRead)?.intValue)
  const cacheWrite = readCount(attributes.get(fields.cacheWrite)?.intValue)
  const reasoning = readCount(attributes.get(fields.reasoning)?.intValue)
  if (cacheRead > totalInput || cacheWrite > totalInput - cacheRead) return invalidTraces()

  const costAttribute = attributes.get(fields.cost)
  return {
    rowKey: createHash('sha256').update(`${traceId.toLowerCase()}:${spanId.toLowerCase()}`, 'ascii').digest('hex'),
    t: formatTimestamp(start), via, model, handedOn: false, input: totalInput - cacheRead - cacheWrite,
    output, cacheRead, cacheWrite, reasoning, cacheUnknown: false,
    cost: costAttribute === undefined ? null : readCost(costAttribute.stringValue),
    status: via === 'through' ? readStatus(attributes.get(fields.status)?.intValue) : null,
    durationMs: Number((end - start) / nanosPerMillisecond),
  }
}

export function readOtlpTraces(value: unknown): { rows: OtlpRow[]; rejectedSpans: number } {
  if (!isRecord(value) || !Array.isArray(value.resourceSpans)) return invalidTraces()
  const rows: OtlpRow[] = []
  let rejectedSpans = 0
  let groupCount = value.resourceSpans.length
  let spanCount = 0
  if (groupCount > maximumGroups) return invalidTraces()
  for (const resource of value.resourceSpans) {
    if (!isRecord(resource) || !Array.isArray(resource.scopeSpans)) return invalidTraces()
    groupCount += resource.scopeSpans.length
    if (groupCount > maximumGroups) return invalidTraces()
    for (const scoped of resource.scopeSpans) {
      if (!isRecord(scoped) || !Array.isArray(scoped.spans)) return invalidTraces()
      spanCount += scoped.spans.length
      if (spanCount > maximumSpans) return invalidTraces()
      if (!isRecord(scoped.scope) || scoped.scope.name !== magpieScope) continue
      for (const span of scoped.spans) {
        try {
          const row = readSpan(span)
          if (row !== null) rows.push(row)
        } catch (error) {
          if (!(error instanceof OtlpParseFailure)) throw error
          rejectedSpans += 1
        }
      }
    }
  }
  return { rows, rejectedSpans }
}
