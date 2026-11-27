import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { readTimeZone } from './center/time.ts'
import { readRevision, readSourceId } from './sync/protocol.ts'

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

type CommonOptions = { gateway: URL; timeoutMs: number }
export type CenterOptions = CommonOptions & { role: 'center'; ingestHost: string; ingestPort: number; timeZone: string }
export type SenderOptions = CommonOptions & { role: 'sender'; centerIngest: URL; sourceId: string; reportKeyFile: string }

export function readOptions(options: Record<string, unknown>): CenterOptions | SenderOptions | null {
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new OptionsFailure('invalid_enabled')
  if (options.collectionMode !== undefined && options.collectionMode !== 'push' && options.collectionMode !== 'pull') {
    throw new OptionsFailure('invalid_collectionMode')
  }
  if (options.enabled !== true || options.collectionMode !== 'push') return null
  if (options.configRevision !== undefined && !readConfigRevision(options.configRevision)) {
    throw new OptionsFailure('invalid_config_revision')
  }
  const { role } = options
  if (role !== 'center' && role !== 'sender') throw new OptionsFailure('invalid_role')
  const gatewayOption = role === 'center' ? 'centerGatewayUrl' : 'sourceGatewayUrl'
  const gateway = readGatewayUrl(options[gatewayOption] === undefined ? 'http://127.0.0.1:3425' : options[gatewayOption])
  if (!gateway) throw new OptionsFailure(`invalid_${gatewayOption}`)
  if (!isLoopback(gateway)) throw new OptionsFailure('gateway_not_loopback')
  const timeout = options.requestTimeoutSec === undefined ? 30 : options.requestTimeoutSec
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 120) {
    throw new OptionsFailure('invalid_requestTimeoutSec')
  }
  const common = { gateway, timeoutMs: timeout * 1_000 }
  if (role === 'center') {
    const { ingestHost = '127.0.0.1', ingestPort = 3494, timeZone = 'Asia/Shanghai' } = options
    const zone = readTimeZone(timeZone)
    if (typeof ingestHost !== 'string' || !isIP(ingestHost)) throw new OptionsFailure('invalid_ingestHost')
    if (typeof ingestPort !== 'number' || !Number.isInteger(ingestPort) || ingestPort < 1 || ingestPort > 65535
      || ingestPort === 3493 || ingestPort === Number(gateway.port || (gateway.protocol === 'https:' ? 443 : 80))) {
      throw new OptionsFailure('invalid_ingestPort')
    }
    if (!zone) throw new OptionsFailure('invalid_timeZone')
    return { ...common, role, ingestHost, ingestPort, timeZone: zone }
  }
  const centerIngest = readGatewayUrl(options.centerIngestUrl)
  if (!centerIngest) throw new OptionsFailure('invalid_centerIngestUrl')
  const sourceId = readSourceId(options.sourceId)
  if (!sourceId || sourceId === 'local') throw new OptionsFailure('invalid_sourceId')
  const { reportKeyFile } = options
  if (typeof reportKeyFile !== 'string' || reportKeyFile.length > 1024 || /[\u0000-\u001f\u007f]/u.test(reportKeyFile)
    || !isAbsolute(reportKeyFile) || (process.platform === 'win32' && !/^[a-z]:[/\\]/i.test(reportKeyFile))) {
    throw new OptionsFailure('invalid_reportKeyFile')
  }
  return { ...common, role, centerIngest, sourceId, reportKeyFile }
}
