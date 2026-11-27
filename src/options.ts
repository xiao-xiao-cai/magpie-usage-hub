export class OptionsFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function readConfigRevision(value: unknown): string | null {
  return typeof value === 'string' && value.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    ? value : null
}

export function readGatewayUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#@\\\s\u0000-\u001f\u007f]+\/?$/iu.test(value)) return
  try {
    const url = new URL(value)
    if (url.href === `${url.origin}/`) return url
  } catch {}
}

export function readCenterOptions(options: Record<string, unknown>) {
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new OptionsFailure('invalid_enabled')
  if (options.collectionMode !== undefined && options.collectionMode !== 'pull') {
    throw new OptionsFailure('invalid_collectionMode')
  }
  if (options.enabled !== true || options.collectionMode !== 'pull') return null
  if (options.configRevision !== undefined && !readConfigRevision(options.configRevision)) {
    throw new OptionsFailure('invalid_config_revision')
  }
  const gateway = readGatewayUrl(options.centerGatewayUrl === undefined ? 'http://127.0.0.1:3425' : options.centerGatewayUrl)
  if (!gateway) throw new OptionsFailure('invalid_centerGatewayUrl')
  if (gateway.hostname !== '127.0.0.1' && gateway.hostname !== '[::1]') throw new OptionsFailure('center_not_loopback')
  const timeout = options.requestTimeoutSec === undefined ? 30 : options.requestTimeoutSec
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 120) {
    throw new OptionsFailure('invalid_requestTimeoutSec')
  }
  return { gateway, timeoutMs: timeout * 1_000 }
}
