import { mkdir, realpath } from 'node:fs/promises'
import { type Diagnostics, updateDiagnosticProgress } from '../diagnostics.ts'
import { GatewayFailure, readGatewayPid } from '../gateway/client.ts'
import type { SyncOptions } from '../options.ts'
import type { RecoveryRequest } from '../recovery.ts'
import { tryAcquireSyncLock } from '../state/lock.ts'
import { openSyncState, saveSyncProgress, StateError, type SyncBinding } from '../state/store.ts'
import { MappingFailure } from './mapping.ts'
import { readValidatedPage, sendUsagePage, SyncFailure } from './read-page.ts'
import { advanceRecoveryPage, prepareRecovery } from './recovery.ts'

const maxPages = 5
const roundBudgetMs = 30_000
const maxRetryDelayMs = 900_000
const retryableCodes = new Set(['network_error', 'timeout', 'rate_limited', 'upstream_failure'])

function log(event: { status: string; [field: string]: unknown }): void {
  const output = event.status === 'blocked' || event.status === 'retrying' ? console.warn : console.info
  output('[magpie-usage-hub]', JSON.stringify(event))
}

async function waitForRetry(error: unknown, failures: number, diagnostics: Diagnostics): Promise<void> {
  if (!(error instanceof GatewayFailure) || !retryableCodes.has(error.code)) throw error
  const backoffMs = Math.min(maxRetryDelayMs, 10_000 * 2 ** Math.min(failures, 7))
  const localDelayMs = Math.min(maxRetryDelayMs, backoffMs + Math.floor(backoffMs * 0.25 * Math.random()))
  const delayMs = Math.max(localDelayMs, error.retryAfterMs ?? 0)
  const retryTime = new Date(Date.now() + delayMs)
  diagnostics.update({ phase: 'retrying',
    failure: { stage: error.stage, code: error.code, httpStatus: error.httpStatus },
    retryAt: Number.isFinite(retryTime.getTime()) ? retryTime.toISOString() : null,
  })
  log({ status: 'retrying', stage: error.stage, code: error.code, httpStatus: error.httpStatus, delayMs })
  const maxTimerMs = 2_147_483_647
  for (let remainingMs = delayMs; remainingMs > 0; remainingMs -= maxTimerMs) {
    await Bun.sleep(Math.min(remainingMs, maxTimerMs))
  }
}

async function checkGatewayOwner(source: URL, timeoutMs: number): Promise<void> {
  const pid = await readGatewayPid(source, timeoutMs)
  if (pid !== process.ppid) throw new SyncFailure('source', 'source_owner_mismatch')
}

async function waitForGatewayOwner(source: URL, timeoutMs: number, diagnostics: Diagnostics): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      diagnostics.update({ lastAttemptAt: new Date().toISOString() })
      await checkGatewayOwner(source, timeoutMs)
      return
    } catch (error) {
      await waitForRetry(error, failures, diagnostics)
    }
  }
}

async function resolveStateDirectory(directory: string): Promise<string> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return await realpath(directory)
  } catch {
    throw new SyncFailure('state', 'state_directory_unavailable')
  }
}

async function poll(
  directory: string, options: SyncOptions, timeoutMs: number, diagnostics: Diagnostics, request?: RecoveryRequest,
): Promise<void> {
  const binding: SyncBinding = {
    sourceGatewayUrl: options.sourceGatewayUrl.href,
    sourceCallerKeyId: options.sourceCallerKeyId,
    centralGatewayUrl: options.centralGatewayUrl.href,
    initialMode: options.initialMode,
  }
  let state = await openSyncState(directory, binding, { requireExisting: request !== undefined })
  if (state.cursor !== null) log({ status: 'resumed' })
  diagnostics.update({ appliedRevision: diagnostics.getStatus().loadedRevision })
  const requestId = request?.id
  updateDiagnosticProgress(diagnostics, state, requestId)

  let failures = 0
  while (true) {
    const roundStarted = performance.now()
    try {
      diagnostics.update({ lastAttemptAt: new Date().toISOString() })
      await checkGatewayOwner(options.sourceGatewayUrl, timeoutMs)
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

function reportBlocked(error: unknown, diagnostics: Diagnostics): void {
  const failure = classifyFailure(error)
  diagnostics.update({ phase: 'blocked', failure, retryAt: null })
  log({ status: 'blocked', ...failure })
}

function classifyFailure(error: unknown) {
  if (error instanceof GatewayFailure) return { stage: error.stage, code: error.code, httpStatus: error.httpStatus }
  if (error instanceof SyncFailure) return { stage: error.stage, code: error.code }
  if (error instanceof StateError) return { stage: 'state' as const, code: error.code }
  if (error instanceof MappingFailure) return { stage: 'mapping' as const, code: error.code }
  return { stage: 'run' as const, code: 'unexpected_failure' }
}

export async function runContinuousSync(
  stateDirectory: string, options: SyncOptions, diagnostics: Diagnostics, request?: RecoveryRequest,
): Promise<void> {
  const timeoutMs = options.requestTimeoutSec * 1_000
  try {
    await waitForGatewayOwner(options.sourceGatewayUrl, timeoutMs, diagnostics)
    const directory = await resolveStateDirectory(stateDirectory)
    let lock = tryAcquireSyncLock(directory)
    if (lock === undefined) log({ status: 'waiting_for_lock' })
    while (lock === undefined) {
      diagnostics.update({ phase: 'waiting_lock', failure: null, retryAt: null })
      await Bun.sleep(1_000)
      await waitForGatewayOwner(options.sourceGatewayUrl, timeoutMs, diagnostics)
      lock = tryAcquireSyncLock(directory)
    }
    try {
      await poll(directory, options, timeoutMs, diagnostics, request)
    } finally {
      lock.release()
    }
  } catch (error) {
    reportBlocked(error, diagnostics)
  }
}
