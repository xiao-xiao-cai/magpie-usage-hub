import { isAbsolute } from 'node:path'

type SourceConnection = {
  sourceGatewayUrl: URL
  centralGatewayUrl: URL
  requestTimeoutSec: number
}

type SyncSettings = SourceConnection & {
  sourceCallerKeyId: string
  sourceProviderId?: string
  initialMode: 'now' | 'start'
  pollIntervalSec: number
}

export type SyncOptions = SyncSettings & { centralKeyFile: string }
export type RuntimeSyncOptions = SyncSettings & ({ centralKeyFile: string } | { reportingKey: string })
export type ManagedSourceOptions = SourceConnection & { mode: 'managed'; pairingCodeFile?: string }

export class OptionsFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function readConfigRevision(value: unknown): string | null {
  return typeof value === 'string' && value.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? value : null
}

export function isProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && [...value].length <= 256
    && !/[\s\u0000-\u001f\u007f]/u.test(value)
}

export function readText(
  raw: Record<string, unknown>, field: keyof SyncOptions | 'centerGatewayUrl' | 'ingestKeyFile' | 'pairingCodeFile',
): string {
  const value = raw[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OptionsFailure(`invalid_${field}`)
  }
  return value
}

export function readGatewayUrl(
  raw: Record<string, unknown>, field: 'sourceGatewayUrl' | 'centralGatewayUrl' | 'centerGatewayUrl',
): URL {
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

export function readSeconds(
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

function readSourceConnection(options: Record<string, unknown>): Pick<SourceConnection, 'sourceGatewayUrl' | 'centralGatewayUrl'> {
  const sourceGatewayUrl = readGatewayUrl(options, 'sourceGatewayUrl')
  if (sourceGatewayUrl.hostname !== '127.0.0.1' && sourceGatewayUrl.hostname !== '[::1]') {
    throw new OptionsFailure('source_not_loopback')
  }
  const centralGatewayUrl = readGatewayUrl(options, 'centralGatewayUrl')
  if (centralGatewayUrl.origin === sourceGatewayUrl.origin) throw new OptionsFailure('same_gateway')
  return { sourceGatewayUrl, centralGatewayUrl }
}

export function readManagedSourceOptions(options: Record<string, unknown>): ManagedSourceOptions | null {
  if (options.enabled === false || options.enabled === undefined) return null
  if (options.enabled !== true) throw new OptionsFailure('invalid_enabled')
  if (options.mode !== 'managed') throw new OptionsFailure('invalid_mode')
  if (options.configRevision !== undefined && readConfigRevision(options.configRevision) === null) {
    throw new OptionsFailure('invalid_config_revision')
  }
  const connection = readSourceConnection(options)
  const pairingCodeFile = options.pairingCodeFile === undefined ? undefined : readText(options, 'pairingCodeFile')
  if (pairingCodeFile !== undefined && !isAbsolute(pairingCodeFile)) throw new OptionsFailure('invalid_pairingCodeFile')
  return { ...connection, mode: 'managed', pairingCodeFile, requestTimeoutSec: readSeconds(options, 'requestTimeoutSec', 30, 1, 120) }
}

export function readSyncOptions(raw: unknown): SyncOptions | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new OptionsFailure('invalid_options')
  const options: Record<string, unknown> = Object.fromEntries(Object.entries(raw))
  if (options.enabled === false || options.enabled === undefined) return null
  if (options.enabled !== true) throw new OptionsFailure('invalid_enabled')
  if (options.role !== undefined && options.role !== 'source') throw new OptionsFailure('invalid_role')
  if (options.mode !== 'continuous') throw new OptionsFailure('invalid_mode')
  if (options.configRevision !== undefined && readConfigRevision(options.configRevision) === null) {
    throw new OptionsFailure('invalid_config_revision')
  }

  const connection = readSourceConnection(options)

  const centralKeyFile = readText(options, 'centralKeyFile')
  if (!isAbsolute(centralKeyFile)) throw new OptionsFailure('invalid_centralKeyFile')
  const sourceCallerKeyId = readText(options, 'sourceCallerKeyId')
  if (sourceCallerKeyId === 'none' || !/^[a-zA-Z0-9_-]+$/.test(sourceCallerKeyId)) {
    throw new OptionsFailure('invalid_sourceCallerKeyId')
  }
  const { sourceProviderId } = options
  if ((options.role === 'source' || sourceProviderId !== undefined) && !isProviderId(sourceProviderId)) {
    throw new OptionsFailure('invalid_sourceProviderId')
  }
  const initialMode = options.initialMode === undefined ? 'now' : options.initialMode
  if (initialMode !== 'now' && initialMode !== 'start') throw new OptionsFailure('invalid_initialMode')
  return {
    ...connection,
    centralKeyFile,
    sourceCallerKeyId,
    ...(typeof sourceProviderId === 'string' ? { sourceProviderId } : {}),
    initialMode,
    pollIntervalSec: readSeconds(options, 'pollIntervalSec', 60, 5, 900),
    requestTimeoutSec: readSeconds(options, 'requestTimeoutSec', 30, 1, 120),
  }
}
