import type { Database } from 'bun:sqlite'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { diagnosticPort, type Diagnostics } from '../diagnostics.ts'
import { acquireGatewayLock, logRuntime, reportBlocked, resolveStateDirectory } from '../host.ts'
import { OptionsFailure, readConfigRevision, readGatewayUrl, readSeconds, readText } from '../options.ts'
import { createDashboard } from './dashboard.ts'
import { checkIngestCredentials, serveIngest } from './ingest.ts'
import { openCenterLedger } from './ledger.ts'
import { createSourceManagement, createSourceRegistry } from './sources.ts'

export function readCenterOptions(options: Record<string, unknown>) {
  if (options.enabled === false || options.enabled === undefined) return null
  if (options.enabled !== true) throw new OptionsFailure('invalid_enabled')
  if (options.configRevision !== undefined && readConfigRevision(options.configRevision) === null) {
    throw new OptionsFailure('invalid_config_revision')
  }
  const gateway = readGatewayUrl(options, 'centerGatewayUrl')
  if (gateway.hostname !== '127.0.0.1' && gateway.hostname !== '[::1]') {
    throw new OptionsFailure('center_not_loopback')
  }
  const keyFile = options.ingestKeyFile === undefined ? undefined : readText(options, 'ingestKeyFile')
  if (keyFile !== undefined && !isAbsolute(keyFile)) throw new OptionsFailure('invalid_ingestKeyFile')
  const host = options.ingestHost ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new OptionsFailure('invalid_ingestHost')
  const port = options.ingestPort === undefined ? 3494 : options.ingestPort
  const gatewayPort = Number(gateway.port || (gateway.protocol === 'https:' ? 443 : 80))
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535
    || port === diagnosticPort || port === gatewayPort) throw new OptionsFailure('invalid_ingestPort')
  const timeoutMs = readSeconds(options, 'requestTimeoutSec', 30, 1, 120) * 1_000
  return { gateway, keyFile, host, port, timeoutMs }
}

type CenterOptions = NonNullable<ReturnType<typeof readCenterOptions>>

export async function runCenter(stateDirectory: string, options: CenterOptions, diagnostics: Diagnostics) {
  let owner: Awaited<ReturnType<typeof acquireGatewayLock>>
  try {
    owner = await acquireGatewayLock(stateDirectory, options.gateway, options.timeoutMs, diagnostics, 'center')
  } catch (error) {
    reportBlocked(error, diagnostics, { stage: 'center', code: 'center_owner_unavailable' })
    return
  }

  let database: Database | null = null
  let manage: ReturnType<typeof createSourceManagement> | undefined
  let code = 'center_ledger_unavailable'
  process.once('exit', () => {
    try { database?.close(true) } catch {}
    try { owner.lock.release() } catch {}
  })
  try {
    const directory = await resolveStateDirectory(join(owner.directory, 'center'))
    if (process.platform !== 'win32' && ((await stat(directory)).mode & 0o077) !== 0) {
      throw new Error('center_state_directory_unprotected')
    }
    database = openCenterLedger(join(directory, 'usage.sqlite'))
    const sources = createSourceRegistry(database)
    manage = createSourceManagement(sources)
    code = 'ingest_credentials_unavailable'
    if (options.keyFile !== undefined) await checkIngestCredentials(options.keyFile)
    code = 'ingest_listener_unavailable'
    serveIngest(database, options.keyFile, options.port, options.host, sources)
    diagnostics.update({ phase: 'receiving', appliedRevision: diagnostics.getStatus().loadedRevision,
      ready: true, failure: null, retryAt: null,
    })
    logRuntime({ status: 'center_ready' })
  } catch (error) {
    reportBlocked(error, diagnostics, { stage: 'center', code })
  }
  return { dashboard: createDashboard(database, options.gateway, options.timeoutMs), manage }
}
