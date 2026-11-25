import { isAbsolute } from 'node:path'

export type TestOptions = {
  runId: string
  sourceId: string
  sourceGatewayUrl: URL
  centralGatewayUrl: URL
  centralKeyFile: string
  sourceCallerKeyId: string
  sourceCursor: string
}

export class OptionsFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function readText(raw: Record<string, unknown>, field: keyof TestOptions): string {
  const value = raw[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OptionsFailure(`invalid_${field}`)
  }
  return value
}

function readId(raw: Record<string, unknown>, field: 'runId' | 'sourceId'): string {
  const value = readText(raw, field)
  if (!uuidV4.test(value)) throw new OptionsFailure(`invalid_${field}`)
  return value.toLowerCase()
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

export function readTestOptions(raw: unknown): TestOptions | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new OptionsFailure('invalid_options')
  const options: Record<string, unknown> = Object.fromEntries(Object.entries(raw))
  if (options.enabled === false || options.enabled === undefined) return null
  if (options.enabled !== true) throw new OptionsFailure('invalid_enabled')

  const runId = readId(options, 'runId')
  const sourceId = readId(options, 'sourceId')
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
  const sourceCursor = readText(options, 'sourceCursor')
  if (sourceCursor === 'start' || sourceCursor === 'now' || sourceCursor !== sourceCursor.trim()) {
    throw new OptionsFailure('invalid_sourceCursor')
  }
  return { runId, sourceId, sourceGatewayUrl, centralGatewayUrl, centralKeyFile, sourceCallerKeyId, sourceCursor }
}
