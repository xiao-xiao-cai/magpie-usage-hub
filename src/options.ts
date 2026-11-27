import { isIP } from 'node:net'
import { readTimeZone } from './center/time.ts'
import { readRevision } from './sync/protocol.ts'

export class OptionsFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function readConfigRevision(value: unknown): string | null {
  return readRevision(value)
}

export function readGatewayUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#@\\\s\u0000-\u001f\u007f]+\/?$/iu.test(value)) return
  try {
    const url = new URL(value)
    if (url.href === `${url.origin}/`) return url
  } catch {}
}

export function isLoopback(url: URL): boolean {
  return url.hostname === '127.0.0.1' || url.hostname === '[::1]'
}

type ReceiverOptions = { host: string; port: number }
  | { error: 'invalid_receiverEnabled' | 'invalid_ingestHost' | 'invalid_ingestPort' } | null

export type CenterOptions = { gateway: URL; timeoutMs: number; receiver: ReceiverOptions; timeZone: string }

function readReceiver(options: Record<string, unknown>, gateway: URL, fresh: boolean): ReceiverOptions {
  const { receiverEnabled = !fresh, ingestHost = '127.0.0.1', ingestPort = 3494 } = options
  if (typeof receiverEnabled !== 'boolean') return { error: 'invalid_receiverEnabled' }
  if (!receiverEnabled) return null
  if (typeof ingestHost !== 'string' || ingestHost.includes('%') || !isIP(ingestHost)) return { error: 'invalid_ingestHost' }
  if (typeof ingestPort !== 'number' || !Number.isInteger(ingestPort) || ingestPort < 1 || ingestPort > 65535
    || ingestPort === 3493 || ingestPort === Number(gateway.port || (gateway.protocol === 'https:' ? 443 : 80))) {
    return { error: 'invalid_ingestPort' }
  }
  return { host: ingestHost, port: ingestPort }
}

export function isFreshInstallation(options: Record<string, unknown>): boolean {
  return Object.keys(options).length === 0
}

export function readOptions(options: Record<string, unknown>, hostAddress?: string): CenterOptions | null {
  const fresh = isFreshInstallation(options)
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new OptionsFailure('invalid_enabled')
  const { collectionMode, role } = options
  if (collectionMode !== undefined && collectionMode !== 'otlp' && collectionMode !== 'push' && collectionMode !== 'pull') {
    throw new OptionsFailure('invalid_collectionMode')
  }
  if (!fresh && (options.enabled !== true || (collectionMode !== 'otlp' && collectionMode !== 'push'))) return null
  if (collectionMode === 'push' && role === 'sender') return null
  if (!fresh && role !== 'center') throw new OptionsFailure('invalid_role')
  if (options.configRevision !== undefined && !readConfigRevision(options.configRevision)) {
    throw new OptionsFailure('invalid_config_revision')
  }
  const hostGateway = hostAddress && (fresh || options.receiverEnabled !== undefined) ? readGatewayUrl(`http://${hostAddress}`) : undefined
  const defaultGateway = hostGateway && isLoopback(hostGateway) ? hostGateway.href : 'http://127.0.0.1:3425'
  const { centerGatewayUrl = defaultGateway, requestTimeoutSec = 30, timeZone = 'Asia/Shanghai' } = options
  const gateway = readGatewayUrl(centerGatewayUrl)
  if (!gateway) throw new OptionsFailure('invalid_centerGatewayUrl')
  if (!isLoopback(gateway)) throw new OptionsFailure('gateway_not_loopback')
  if (typeof requestTimeoutSec !== 'number' || !Number.isInteger(requestTimeoutSec)
    || requestTimeoutSec < 1 || requestTimeoutSec > 120) {
    throw new OptionsFailure('invalid_requestTimeoutSec')
  }
  const zone = readTimeZone(timeZone)
  if (!zone) throw new OptionsFailure('invalid_timeZone')
  return { gateway, timeoutMs: requestTimeoutSec * 1_000, receiver: readReceiver(options, gateway, fresh), timeZone: zone }
}
