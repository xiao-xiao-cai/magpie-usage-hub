import type { SyncBinding } from './state/store.ts'

type RecoveryScope = Readonly<{ id: string; from: string; binding: SyncBinding }>

export type RecoveryRequest = RecoveryScope & (
  | Readonly<{ kind: 'range'; to: string }>
  | Readonly<{ kind: 'cursor' }>
)

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export class RecoveryRequestError extends Error {
  readonly code = 'invalid_recovery_request'

  constructor() {
    super('invalid_recovery_request')
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readDate(value: unknown): string {
  if (typeof value !== 'string') throw new RecoveryRequestError()
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new RecoveryRequestError()
  return value
}

function readGatewayRoot(value: unknown): URL {
  if (typeof value !== 'string') throw new RecoveryRequestError()
  const url = URL.parse(value)
  if (url === null || url.href !== value || url.href !== `${url.origin}/`
    || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new RecoveryRequestError()
  }
  return url
}

export function decodeRecoveryRequest(raw: unknown): RecoveryRequest {
  if (!isObject(raw) || !isObject(raw.binding)) throw new RecoveryRequestError()
  const { id, kind } = raw
  const { sourceCallerKeyId, initialMode } = raw.binding
  if (typeof id !== 'string' || !uuidV4.test(id)
    || typeof sourceCallerKeyId !== 'string' || sourceCallerKeyId === 'none'
    || !/^[a-zA-Z0-9_-]+$/.test(sourceCallerKeyId) || (initialMode !== 'now' && initialMode !== 'start')) {
    throw new RecoveryRequestError()
  }
  const source = readGatewayRoot(raw.binding.sourceGatewayUrl)
  const center = readGatewayRoot(raw.binding.centralGatewayUrl)
  if ((source.hostname !== '127.0.0.1' && source.hostname !== '[::1]') || source.origin === center.origin) {
    throw new RecoveryRequestError()
  }
  const from = readDate(raw.from)
  const binding: SyncBinding = {
    sourceGatewayUrl: source.href,
    sourceCallerKeyId,
    centralGatewayUrl: center.href,
    initialMode,
  }
  const scope = { id, from, binding }
  if (kind === 'cursor' && raw.to === undefined) return { ...scope, kind }
  if (kind === 'range') {
    const to = readDate(raw.to)
    if (Date.parse(from) < Date.parse(to)) return { ...scope, kind, to }
  }
  throw new RecoveryRequestError()
}

export function readRecoveryRequest(raw: unknown): RecoveryRequest | undefined {
  if (raw === undefined) return undefined
  const request = decodeRecoveryRequest(raw)
  if (Date.parse(request.kind === 'range' ? request.to : request.from) > Date.now()) {
    throw new RecoveryRequestError()
  }
  return request
}
