import type { Diagnostics } from '../diagnostics.ts'
import { isRecord } from '../center/http.ts'
import { openReportingTarget, ReportingFailure } from '../gateway/reporting.ts'
import { acquireGatewayLock, logRuntime, preparePushDirectory, reportBlocked } from '../host.ts'
import type { SenderOptions } from '../options.ts'
import { StateError } from '../state/errors.ts'
import { readStateJson, writeStateJson } from '../state/store.ts'
import { readRevision, type Checkpoint } from './protocol.ts'
import { runSynchronization } from './runner.ts'

async function openBinding(directory: string, stateDirectory: string, options: SenderOptions) {
  const expected = { version: 1, sourceId: options.sourceId, centerUrl: options.centerIngest.href,
    sourceUrl: options.gateway.href, directory: stateDirectory,
  }
  const saved = await readStateJson(directory, 'sender.json')
  let centerId: string | null = null
  if (saved !== undefined) {
    if (!isRecord(saved) || !(centerId = readRevision(saved.centerId))
      || Object.entries(expected).some(([key, value]) => saved[key] !== value)) throw new StateError('state_invalid')
  }
  return async (checkpoint: Checkpoint) => {
    if (centerId) {
      if (checkpoint.centerId !== centerId) throw new ReportingFailure('source_binding_mismatch')
      return
    }
    await writeStateJson(directory, 'sender.json', { ...expected, centerId: checkpoint.centerId })
    centerId = checkpoint.centerId
  }
}

export async function runSender(stateDirectory: string, options: SenderOptions, diagnostics: Diagnostics) {
  let owner: Awaited<ReturnType<typeof acquireGatewayLock>> | undefined
  try {
    const host = await acquireGatewayLock(stateDirectory, options.gateway, options.timeoutMs, diagnostics)
    owner = host
    const directory = await preparePushDirectory(host.directory)
    const bind = await openBinding(directory, host.directory, options)
    diagnostics.update({ appliedRevision: diagnostics.getStatus().loadedRevision, phase: 'starting', failure: null, retryAt: null })
    logRuntime({ status: 'sender_started' })
    await runSynchronization(options, async () => {
      await host.checkCollectionGateway()
      return openReportingTarget(options.centerIngest, options.reportKeyFile, options.timeoutMs)
    }, diagnostics, bind)
  } catch (error) {
    reportBlocked(error, diagnostics, 'sender_unavailable')
  } finally {
    try { owner?.lock.release() } catch {}
  }
}
