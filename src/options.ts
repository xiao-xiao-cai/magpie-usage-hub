import { isAbsolute } from 'node:path'

export type SyncOptions = {
  sourceGatewayUrl: URL
  centralGatewayUrl: URL
  centralKeyFile: string
  sourceCallerKeyId: string
  initialMode: 'now' | 'start'
  pollIntervalSec: number
  requestTimeoutSec: number
}

export class OptionsFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function readText(raw: Record<string, unknown>, field: keyof SyncOptions): string {
  const value = raw[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OptionsFailure(`invalid_${field}`)
  }
  return value
}

function readGatewayUrl(raw: Record<string, unknown>, field: 'sourceGatewayUrl' | 'centralGatewayUrl'): URL {
  let url: URL
  try {
    url = new URL(readText(raw, field))
  } catch {
    throw new OptionsFailure(`invalid_${field}`)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.href !== `${url.origin}/`) {
    throw new OptionsFailure(`invalid_${field}`)
  }
  return url
}

function readSeconds(
  options: Record<string, unknown>,
  field: 'pollIntervalSec' | 'requestTimeoutSec',
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = options[field]
  if (value === undefined) return defaultValue
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new OptionsFailure(`invalid_${field}`)
  }
  return value
}

export function readSyncOptions(raw: unknown): SyncOptions | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new OptionsFailure('invalid_options')
  const options: Record<string, unknown> = Object.fromEntries(Object.entries(raw))
  if (options.enabled === false || options.enabled === undefined) return null
  if (options.enabled !== true) throw new OptionsFailure('invalid_enabled')
  if (options.mode !== 'continuous') throw new OptionsFailure('invalid_mode')

  const sourceGatewayUrl = readGatewayUrl(options, 'sourceGatewayUrl')
  if (sourceGatewayUrl.hostname !== '127.0.0.1' && sourceGatewayUrl.hostname !== '[::1]') {
    throw new OptionsFailure('source_not_loopback')
  }
  const centralGatewayUrl = readGatewayUrl(options, 'centralGatewayUrl')
  if (centralGatewayUrl.origin === sourceGatewayUrl.origin) throw new OptionsFailure('same_gateway')

  const centralKeyFile = readText(options, 'centralKeyFile')
  if (!isAbsolute(centralKeyFile)) throw new OptionsFailure('invalid_centralKeyFile')
  const sourceCallerKeyId = readText(options, 'sourceCallerKeyId')
  if (sourceCallerKeyId === 'none' || !/^[a-zA-Z0-9_-]+$/.test(sourceCallerKeyId)) {
    throw new OptionsFailure('invalid_sourceCallerKeyId')
  }
  const initialMode = options.initialMode === undefined ? 'now' : options.initialMode
  if (initialMode !== 'now' && initialMode !== 'start') throw new OptionsFailure('invalid_initialMode')
  return {
    sourceGatewayUrl,
    centralGatewayUrl,
    centralKeyFile,
    sourceCallerKeyId,
    initialMode,
    pollIntervalSec: readSeconds(options, 'pollIntervalSec', 60, 5, 900),
    requestTimeoutSec: readSeconds(options, 'requestTimeoutSec', 30, 1, 120),
  }
}
