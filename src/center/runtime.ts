import { join } from 'node:path'
import type { Diagnostics } from '../diagnostics.ts'
import { acquireGatewayLock, logRuntime, prepareLedgerDirectory, reportBlocked } from '../host.ts'
import type { CenterOptions } from '../options.ts'
import { ReportingFailure, runSynchronization, type ReportingTarget } from '../sync/runner.ts'
import { createDashboard } from './dashboard.ts'
import { createIngest, maximumOtlpBodyBytes } from './ingest.ts'
import { CenterFailure, openCenterLedger } from './ledger.ts'
import { createSourceManagement } from './sources.ts'

function localReporting<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof CenterFailure) throw new ReportingFailure(error.code, error.httpStatus)
    throw new ReportingFailure('unavailable')
  }
}

export async function runCenter(stateDirectory: string, options: CenterOptions, diagnostics: Diagnostics) {
  let owner: Awaited<ReturnType<typeof acquireGatewayLock>>
  try {
    owner = await acquireGatewayLock(stateDirectory, options.gateway, options.timeoutMs, diagnostics)
  } catch (error) {
    reportBlocked(error, diagnostics, 'center_owner_unavailable')
    return
  }

  let close: (() => void) | undefined
  try {
    const directory = await prepareLedgerDirectory(owner.directory)
    const ledger = openCenterLedger(join(directory, 'center.sqlite'))
    close = () => ledger.db.close()
    let listenerFailure: { stage: 'options' | 'center'; code: string } | null = null
    if (options.receiver && 'error' in options.receiver) {
      listenerFailure = { stage: 'options', code: options.receiver.error }
    } else if (options.receiver) {
      try {
        const receiver = Bun.serve({
          hostname: options.receiver.host, port: options.receiver.port, fetch: createIngest(ledger),
          maxRequestBodySize: maximumOtlpBodyBytes, idleTimeout: 15, development: false,
        })
        receiver.unref()
        close = () => {
          try { void receiver.stop(true) } finally { ledger.db.close() }
        }
      } catch {
        listenerFailure = { stage: 'center', code: 'ingest_listener_unavailable' }
      }
    }
    const sourceId = 'local'
    const local: ReportingTarget = {
      checkpoint: () => localReporting(() => ledger.checkpoint(sourceId)),
      commit: page => localReporting(() => ledger.commit(page)),
      recover: report => localReporting(() => ledger.recover(report)),
    }
    const services = {
      dashboard: createDashboard(ledger, options.timeZone),
      manage: createSourceManagement(ledger),
    }
    process.once('exit', () => {
      try { close?.() } catch {}
      try { owner.lock.release() } catch {}
    })
    diagnostics.update({ phase: 'ready', appliedRevision: listenerFailure ? null : diagnostics.getStatus().loadedRevision,
      receiver: listenerFailure ? 'failed' : options.receiver ? 'listening' : 'off',
      ready: true, failure: listenerFailure, retryAt: null, collectorPhase: 'starting',
    })
    logRuntime({ status: 'center_ready', receiver: diagnostics.getStatus().receiver, ...(listenerFailure ?? {}) })
    void runSynchronization({ ...options, sourceId }, async () => {
      await owner.checkCollectionGateway()
      return local
    }, diagnostics)
    return services
  } catch (error) {
    try { close?.() } catch {}
    try { owner.lock.release() } catch {}
    reportBlocked(error, diagnostics, 'center_unavailable')
  }
}
