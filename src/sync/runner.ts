import type { Diagnostics } from '../diagnostics.ts'
import { GatewayFailure, readNativeChanges } from '../gateway/client.ts'
import { logRuntime } from '../host.ts'
import { StateError } from '../state/errors.ts'
import { mapNativePage } from './mapping.ts'
import { readCursorFailure, type Checkpoint, type PageReceipt, type PageSubmission, type RecoveryReport } from './protocol.ts'

export class ReportingFailure extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) { super(code) }
}

export type ReportingTarget = {
  checkpoint(): Checkpoint
  commit(page: PageSubmission): PageReceipt
  recover(report: RecoveryReport): Checkpoint
}

type SyncOptions = { gateway: URL; timeoutMs: number; sourceId: string }
type Observe = (checkpoint: Checkpoint, committed: boolean) => void

function verifySource(checkpoint: Checkpoint, sourceId: string, centerId?: string) {
  if (checkpoint.sourceId !== sourceId || (centerId !== undefined && checkpoint.centerId !== centerId)) {
    throw new ReportingFailure('source_binding_mismatch')
  }
}

export async function synchronizeRound(
  options: SyncOptions, target: ReportingTarget, observe: Observe,
): Promise<Checkpoint> {
  const until = performance.now() + 30_000
  let checkpoint = target.checkpoint()
  verifySource(checkpoint, options.sourceId)
  observe(checkpoint, false)
  if (checkpoint.phase === 'paused' || checkpoint.phase === 'recovery_required') return checkpoint
  const { centerId } = checkpoint

  for (let index = 0; index < 5; index += 1) {
    let nativePage: unknown
    try {
      nativePage = await readNativeChanges(options.gateway, checkpoint.cursor, options.timeoutMs)
    } catch (error) {
      const reason = error instanceof GatewayFailure ? readCursorFailure(error.code) : null
      if (!reason) throw error
      const recovered = target.recover({ sourceId: options.sourceId, revision: checkpoint.revision, reason })
      verifySource(recovered, options.sourceId, centerId)
      if (recovered.revision === checkpoint.revision || (recovered.phase !== 'rebuilding' && recovered.phase !== 'recovery_required')) {
        throw new ReportingFailure('invalid_checkpoint')
      }
      observe(recovered, false)
      return recovered
    }
    const page = mapNativePage(nativePage, checkpoint)
    const receipt = target.commit(page)
    checkpoint = receipt.checkpoint
    verifySource(checkpoint, options.sourceId, centerId)
    observe(checkpoint, true)
    if (!checkpoint.hasMore || performance.now() >= until) break
  }
  return checkpoint
}

const transient = new Set(['timeout', 'unavailable', 'rate_limited'])
const steadyIntervalMs = 60_000

export async function runSynchronization(
  options: SyncOptions, openTarget: () => Promise<ReportingTarget>, diagnostics: Diagnostics,
) {
  let consecutiveFailures = 0
  let previousIssue: string | null = null
  for (;;) {
    diagnostics.update({ lastAttemptAt: new Date().toISOString() })
    let delay = steadyIntervalMs
    try {
      const current = await synchronizeRound(options, await openTarget(), (checkpoint, committed) => {
        const recoveryRequired = checkpoint.phase === 'recovery_required'
        diagnostics.update({ syncPhase: checkpoint.phase, hasMore: checkpoint.hasMore, lastSyncedAt: checkpoint.lastSyncedAt,
          ...(committed ? { lastPageAt: new Date().toISOString() } : {}),
          collectorPhase: recoveryRequired ? 'blocked' : 'ready', collectorRetryAt: null,
          collectorFailure: recoveryRequired ? { stage: 'source', code: 'source_recovery_required' } : null,
        })
      })
      consecutiveFailures = 0
      previousIssue = null
      if (current.phase !== 'paused' && current.phase !== 'recovery_required' && current.hasMore) delay = 250
    } catch (error) {
      const failure = error instanceof GatewayFailure
        ? { stage: 'source' as const, code: error.code, httpStatus: error.httpStatus }
        : error instanceof ReportingFailure ? { stage: 'center' as const, code: error.code, httpStatus: error.httpStatus }
          : { stage: 'state' as const, code: error instanceof StateError ? error.code : 'sync_failed' }
      let phase: 'retrying' | 'blocked' = 'blocked'
      if (transient.has(failure.code)) {
        const backoff = 10_000 * 2 ** Math.min(consecutiveFailures, 5)
        delay = Math.min(300_000, backoff + Math.floor(backoff * 0.25 * Math.random()))
        consecutiveFailures += 1
        phase = 'retrying'
      } else if (failure.code === 'checkpoint_conflict') {
        phase = 'retrying'
        delay = 1_000
      } else if (failure.code === 'source_paused') {
        diagnostics.update({ syncPhase: 'paused' })
        phase = 'retrying'
      }
      diagnostics.update({ collectorPhase: phase, collectorFailure: failure,
        collectorRetryAt: new Date(Date.now() + delay).toISOString() })
      const issue = `${failure.stage}/${failure.code}`
      if (issue !== previousIssue) logRuntime({ status: phase, ...failure })
      previousIssue = issue
    }
    await Bun.sleep(delay)
  }
}
