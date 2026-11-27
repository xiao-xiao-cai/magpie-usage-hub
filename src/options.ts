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

export type CenterOptions = { gateway: URL; timeoutMs: number; ingestHost: string; ingestPort: number; timeZone: string }

export function readOptions(options: Record<string, unknown>): CenterOptions | null {
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new OptionsFailure('invalid_enabled')
  const { collectionMode, role } = options
  if (collectionMode !== undefined && collectionMode !== 'otlp' && collectionMode !== 'push' && collectionMode !== 'pull') {
    throw new OptionsFailure('invalid_collectionMode')
  }
  if (options.enabled !== true || (collectionMode !== 'otlp' && collectionMode !== 'push')) return null
  if (collectionMode === 'push' && role === 'sender') return null
  if (role !== 'center') throw new OptionsFailure('invalid_role')
  if (options.configRevision !== undefined && !readConfigRevision(options.configRevision)) {
    throw new OptionsFailure('invalid_config_revision')
  }
  const { centerGatewayUrl = 'http://127.0.0.1:3425', requestTimeoutSec = 30,
    ingestHost = '127.0.0.1', ingestPort = 3494, timeZone = 'Asia/Shanghai' } = options
  const gateway = readGatewayUrl(centerGatewayUrl)
  if (!gateway) throw new OptionsFailure('invalid_centerGatewayUrl')
  if (!isLoopback(gateway)) throw new OptionsFailure('gateway_not_loopback')
  if (typeof requestTimeoutSec !== 'number' || !Number.isInteger(requestTimeoutSec)
    || requestTimeoutSec < 1 || requestTimeoutSec > 120) {
    throw new OptionsFailure('invalid_requestTimeoutSec')
  }
  if (typeof ingestHost !== 'string' || !isIP(ingestHost)) throw new OptionsFailure('invalid_ingestHost')
  if (typeof ingestPort !== 'number' || !Number.isInteger(ingestPort) || ingestPort < 1 || ingestPort > 65535
    || ingestPort === 3493 || ingestPort === Number(gateway.port || (gateway.protocol === 'https:' ? 443 : 80))) {
    throw new OptionsFailure('invalid_ingestPort')
  }
  const zone = readTimeZone(timeZone)
  if (!zone) throw new OptionsFailure('invalid_timeZone')
  return { gateway, timeoutMs: requestTimeoutSec * 1_000, ingestHost, ingestPort, timeZone: zone }
}
