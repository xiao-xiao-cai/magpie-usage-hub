import { join } from 'node:path'
import { createDiagnostics, type Diagnostics } from '../diagnostics.ts'
import { ReportingFailure, type ReportingTarget } from '../gateway/reporting.ts'
import { acquireGatewayLock, logRuntime, preparePushDirectory, reportBlocked } from '../host.ts'
import type { CenterOptions } from '../options.ts'
import { pageBodyLimit } from '../sync/protocol.ts'
import { runSynchronization } from '../sync/runner.ts'
import { createDashboard } from './dashboard.ts'
import { createIngest } from './ingest.ts'
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
    const directory = await preparePushDirectory(owner.directory)
    const ledger = openCenterLedger(join(directory, 'center.sqlite'))
    close = () => ledger.db.close()
    const receiver = Bun.serve({
      hostname: options.ingestHost, port: options.ingestPort, fetch: createIngest(ledger),
      maxRequestBodySize: pageBodyLimit, idleTimeout: 15, development: false,
    })
    receiver.unref()
    close = () => {
      try { void receiver.stop(true) } finally { ledger.db.close() }
    }
    process.once('exit', () => {
      try { ledger.db.close() } catch {}
      try { owner.lock.release() } catch {}
    })
    const sourceId = 'local'
    const local: ReportingTarget = {
      checkpoint: () => localReporting(() => ledger.checkpoint(sourceId)),
      commit: page => localReporting(() => ledger.commit(page)),
      recover: report => localReporting(() => ledger.recover(report)),
    }
    const collectorStatus = createDiagnostics(diagnostics.getStatus().loadedRevision, 'center')
    diagnostics.update({ phase: 'ready', appliedRevision: diagnostics.getStatus().loadedRevision,
      ready: true, failure: null, retryAt: null,
    })
    logRuntime({ status: 'center_ready' })
    void runSynchronization({ ...options, sourceId }, async () => {
      await owner.checkCollectionGateway()
      return local
    }, collectorStatus, () => {})
    return {
      dashboard: createDashboard(ledger, options.timeZone),
      manage: createSourceManagement(ledger),
    }
  } catch (error) {
    try { close?.() } catch {}
    try { owner.lock.release() } catch {}
    reportBlocked(error, diagnostics, 'center_unavailable')
  }
}
