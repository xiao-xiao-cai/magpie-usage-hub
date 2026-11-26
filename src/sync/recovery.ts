import { GatewayFailure, type UsagePage } from '../gateway/client.ts'
import type { SyncOptions } from '../options.ts'
import type { RecoveryRequest } from '../recovery.ts'
import {
  sameBinding, saveRecoveryState, StateError,
  type RecoveryRejectionCode, type RecoveryScanFailureCode, type SyncState, type WriteOperations,
} from '../state/store.ts'
import { readValidatedPage, sendUsagePage } from './read-page.ts'

async function checkPriorCursor(
  options: SyncOptions, cursor: string, timeoutMs: number,
): Promise<RecoveryRejectionCode | undefined> {
  try {
    await readValidatedPage(options, cursor, timeoutMs)
    return 'recovery_cursor_valid'
  } catch (error) {
    if (error instanceof GatewayFailure && error.stage === 'source') {
      if (error.code === 'cursor_reset' || error.code === 'cursor_expired') return undefined
      if (error.code === 'cursor_invalid' || error.code === 'cursor_filter_changed') return 'recovery_cursor_incompatible'
    }
    throw error
  }
}

export async function prepareRecovery(
  directory: string, state: SyncState, request: RecoveryRequest | undefined, options: SyncOptions, timeoutMs: number,
): Promise<SyncState> {
  if (request === undefined) return state
  const recovery = state.recovery ?? { active: null, results: [] }
  if (recovery.active?.request.id === request.id || recovery.results.some(result => result.request.id === request.id)) {
    return state
  }

  let reason: RecoveryRejectionCode | undefined
  if (!sameBinding(state.binding, request.binding)) reason = 'recovery_binding_mismatch'
  else if (state.cursor === null) reason = 'recovery_no_checkpoint'
  else if (recovery.active) reason = 'recovery_busy'
  else if (request.kind === 'cursor') reason = await checkPriorCursor(options, state.cursor, timeoutMs)

  if (reason !== undefined) {
    const result = { request, status: 'rejected', reason } as const
    return saveRecoveryState(directory, {
      ...state,
      recovery: { ...recovery, results: [...recovery.results, result] },
    })
  }
  return saveRecoveryState(directory, {
    ...state,
    version: 2,
    recovery: {
      ...recovery,
      active: { request, cursor: null, pages: 0, accepted: 0, skipped: 0, lastConfirmedAt: null },
    },
  })
}

export async function advanceRecoveryPage(
  directory: string, state: SyncState, options: SyncOptions, timeoutMs: number, operations?: WriteOperations,
): Promise<
  | { status: 'confirmed'; state: SyncState; accepted: number; skipped: number; hasMore: boolean }
  | { status: 'failed'; state: SyncState; reason: RecoveryScanFailureCode }
> {
  const recovery = state.recovery
  if (!recovery?.active) throw new StateError('state_invalid')
  const { active } = recovery
  const { request } = active
  const from = Date.parse(request.from)
  const to = request.kind === 'range' ? Date.parse(request.to) : Infinity
  let page: UsagePage
  try {
    page = await readValidatedPage(options, active.cursor ?? 'start', timeoutMs)
  } catch (error) {
    if (!(error instanceof GatewayFailure) || error.stage !== 'source'
      || (error.code !== 'cursor_expired' && error.code !== 'cursor_reset')) throw error
    const reason: RecoveryScanFailureCode = error.code === 'cursor_expired'
      ? 'recovery_scan_cursor_expired' : 'recovery_scan_cursor_reset'
    const failed = {
      request,
      status: 'failed' as const,
      reason,
      pages: active.pages,
      accepted: active.accepted,
      skipped: active.skipped,
      lastConfirmedAt: active.lastConfirmedAt,
      failedAt: new Date().toISOString(),
    }
    const saved = await saveRecoveryState(directory, {
      ...state, recovery: { active: null, results: [...recovery.results, failed] },
    }, operations)
    return { status: 'failed', state: saved, reason }
  }
  const { accepted, skipped } = await sendUsagePage(options, page, state.sourceInstanceId, timeoutMs, timestamp => {
    const originalTime = Date.parse(timestamp)
    return originalTime >= from && originalTime < to
  })

  const lastConfirmedAt = new Date().toISOString()
  const confirmed = {
    request,
    pages: active.pages + 1,
    accepted: active.accepted + accepted,
    skipped: active.skipped + skipped,
    lastConfirmedAt,
  }
  const nextRecovery = page.hasMore
    ? { ...recovery, active: { ...confirmed, cursor: page.nextCursor } }
    : { active: null, results: [...recovery.results, { ...confirmed, status: 'complete' } as const] }
  const replacementCursor = !page.hasMore && request.kind === 'cursor'
    ? { cursor: page.nextCursor, lastConfirmedAt }
    : undefined
  const saved = await saveRecoveryState(directory, { ...state, ...replacementCursor, recovery: nextRecovery }, operations)
  return { status: 'confirmed', state: saved, accepted, skipped, hasMore: page.hasMore }
}
