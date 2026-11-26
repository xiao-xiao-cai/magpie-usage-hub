import { join } from 'node:path'
import { type Diagnostics, updateDiagnosticProgress } from '../diagnostics.ts'
import { acquireGatewayLock, checkGatewayOwner, logRuntime as log, reportBlocked, resolveStateDirectory, waitForRetry } from '../host.ts'
import type { ManagedSourceOptions, RuntimeSyncOptions, SyncOptions } from '../options.ts'
import type { RecoveryRequest } from '../recovery.ts'
import { openSyncState, sameBinding, saveSyncProgress, StateError, type SyncBinding, type SyncState } from '../state/store.ts'
import { openManagedSource } from './managed.ts'
import { MappingFailure } from './mapping.ts'
import { readValidatedPage, sendUsagePage } from './read-page.ts'
import { advanceRecoveryPage, prepareRecovery } from './recovery.ts'

const maxPages = 5
const roundBudgetMs = 30_000

type RoundConfig = { options: RuntimeSyncOptions; enabled: boolean; sourceInstanceId?: string }

function bindingFor(options: RuntimeSyncOptions): SyncBinding {
  return {
    sourceGatewayUrl: options.sourceGatewayUrl.href,
    sourceCallerKeyId: options.sourceCallerKeyId,
    ...(options.sourceProviderId === undefined ? {} : { sourceProviderId: options.sourceProviderId }),
    centralGatewayUrl: options.centralGatewayUrl.href,
    initialMode: options.initialMode,
  }
}

async function poll(
  directory: string, sourceGateway: URL, timeoutMs: number, diagnostics: Diagnostics,
  readConfig: () => Promise<RoundConfig>, request?: RecoveryRequest,
): Promise<void> {
  const requestId = request?.id
  let state: SyncState | undefined
  let failures = 0
  while (true) {
    const roundStarted = performance.now()
    try {
      diagnostics.update({ lastAttemptAt: new Date().toISOString() })
      await checkGatewayOwner(sourceGateway, timeoutMs, 'source')
      const { options, enabled, sourceInstanceId } = await readConfig()
      const binding = bindingFor(options)
      if (state === undefined) {
        state = await openSyncState(directory, binding, { requireExisting: request !== undefined, sourceInstanceId })
        if (state.cursor !== null) log({ status: 'resumed' })
        diagnostics.update({ appliedRevision: diagnostics.getStatus().loadedRevision })
        updateDiagnosticProgress(diagnostics, state, requestId)
      } else if (!sameBinding(state.binding, binding)) {
        throw new StateError('binding_mismatch')
      }
      if (!enabled) {
        diagnostics.update({ phase: 'paused', failure: null, retryAt: null })
        failures = 0
        await Bun.sleep(options.pollIntervalSec * 1_000)
        continue
      }
      if (request !== undefined) {
        diagnostics.update({ phase: 'recovering', lastAttemptAt: new Date().toISOString(), failure: null, retryAt: null })
        state = await prepareRecovery(directory, state, request, options, timeoutMs)
        request = undefined
        updateDiagnosticProgress(diagnostics, state, requestId)
      }
      for (let pages = 0; pages < maxPages; pages += 1) {
        const recovering = state.recovery?.active != null
        diagnostics.update({ phase: recovering ? 'recovering' : 'syncing',
          lastAttemptAt: new Date().toISOString(), failure: null, retryAt: null,
        })
        let receipt: { accepted: number; skipped: number; hasMore: boolean }
        if (recovering) {
          const next = await advanceRecoveryPage(directory, state, options, timeoutMs)
          state = next.state
          if (next.status === 'failed') {
            updateDiagnosticProgress(diagnostics, state, requestId)
            log({ status: 'recovery_failed', code: next.reason })
            continue
          }
          receipt = { accepted: next.accepted, skipped: next.skipped, hasMore: next.hasMore }
        } else {
          const initializing = state.cursor === null
          const page = await readValidatedPage(options, state.cursor ?? options.initialMode, timeoutMs)
          const counts = await sendUsagePage(options, page, state.sourceInstanceId, timeoutMs)
          state = await saveSyncProgress(directory, state, page.nextCursor)
          receipt = { ...counts, hasMore: page.hasMore }
          if (initializing) log({ status: 'ready' })
        }
        diagnostics.update({ lastPage: { ...receipt, kind: recovering ? 'recovery' : 'sync' } })
        updateDiagnosticProgress(diagnostics, state, requestId)
        if (recovering || receipt.accepted > 0 || receipt.skipped > 0) {
          log({ status: recovering ? 'recovery_confirmed' : 'confirmed', ...receipt })
        }

        failures = 0
        if ((!recovering && !receipt.hasMore) || performance.now() - roundStarted >= roundBudgetMs) break
      }
      diagnostics.update({ phase: state.recovery?.active ? 'recovering' : 'idle' })
      await Bun.sleep(options.pollIntervalSec * 1_000)
    } catch (error) {
      await waitForRetry(error, failures, diagnostics)
      failures += 1
    }
  }
}

export async function runContinuousSync(
  stateDirectory: string, options: SyncOptions | ManagedSourceOptions, diagnostics: Diagnostics, request?: RecoveryRequest,
): Promise<void> {
  const timeoutMs = options.requestTimeoutSec * 1_000
  try {
    const { directory, lock } = await acquireGatewayLock(stateDirectory, options.sourceGatewayUrl, timeoutMs, diagnostics, 'source')
    try {
      if ('mode' in options) {
        const progress = await resolveStateDirectory(join(directory, 'managed'))
        const readConfig = await openManagedSource(progress, options, diagnostics)
        await poll(progress, options.sourceGatewayUrl, timeoutMs, diagnostics, readConfig)
      } else {
        const progress = options.sourceProviderId === undefined ? directory : await resolveStateDirectory(join(directory, 'trial'))
        await poll(progress, options.sourceGatewayUrl, timeoutMs, diagnostics, async () => ({ options, enabled: true }), request)
      }
    } finally {
      lock.release()
    }
  } catch (error) {
    reportBlocked(error, diagnostics, error instanceof MappingFailure
      ? { stage: 'mapping', code: error.code } : { stage: 'run', code: 'unexpected_failure' })
  }
}
