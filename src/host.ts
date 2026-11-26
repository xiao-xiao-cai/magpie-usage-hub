import { mkdir, realpath } from 'node:fs/promises'
import type { Diagnostics } from './diagnostics.ts'
import { GatewayFailure, readGatewayPid } from './gateway/client.ts'
import { StateError } from './state/errors.ts'
import { tryAcquireSyncLock } from './state/lock.ts'
import { SyncFailure } from './sync/read-page.ts'

const maxRetryDelayMs = 900_000
const retryableCodes = new Set(['network_error', 'timeout', 'rate_limited', 'upstream_failure', 'source_paused'])

export function logRuntime(event: { status: string; [field: string]: unknown }): void {
  const output = event.status === 'blocked' || event.status === 'retrying' ? console.warn : console.info
  output('[magpie-usage-hub]', JSON.stringify(event))
}

export async function waitForRetry(error: unknown, failures: number, diagnostics: Diagnostics): Promise<void> {
  if (!(error instanceof GatewayFailure) || !retryableCodes.has(error.code)) throw error
  const backoffMs = Math.min(maxRetryDelayMs, 10_000 * 2 ** Math.min(failures, 7))
  const localDelayMs = Math.min(maxRetryDelayMs, backoffMs + Math.floor(backoffMs * 0.25 * Math.random()))
  const delayMs = Math.max(localDelayMs, error.retryAfterMs ?? 0)
  const retryTime = new Date(Date.now() + delayMs)
  diagnostics.update({ phase: 'retrying',
    failure: { stage: error.stage, code: error.code, httpStatus: error.httpStatus },
    retryAt: Number.isFinite(retryTime.getTime()) ? retryTime.toISOString() : null,
  })
  logRuntime({ status: 'retrying', stage: error.stage, code: error.code, httpStatus: error.httpStatus, delayMs })
  const maxTimerMs = 2_147_483_647
  for (let remainingMs = delayMs; remainingMs > 0; remainingMs -= maxTimerMs) {
    await Bun.sleep(Math.min(remainingMs, maxTimerMs))
  }
}

export async function checkGatewayOwner(gateway: URL, timeoutMs: number, role: 'source' | 'center'): Promise<void> {
  const pid = await readGatewayPid(gateway, timeoutMs, role)
  if (pid !== process.ppid) throw new SyncFailure(role, `${role}_owner_mismatch`)
}

export async function resolveStateDirectory(directory: string): Promise<string> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return await realpath(directory)
  } catch {
    throw new SyncFailure('state', 'state_directory_unavailable')
  }
}

export async function acquireGatewayLock(
  stateDirectory: string, gateway: URL, timeoutMs: number, diagnostics: Diagnostics, role: 'source' | 'center',
) {
  let directory: string | undefined
  for (;;) {
    for (let failures = 0; ; failures += 1) {
      try {
        diagnostics.update({ lastAttemptAt: new Date().toISOString() })
        await checkGatewayOwner(gateway, timeoutMs, role)
        break
      } catch (error) {
        await waitForRetry(error, failures, diagnostics)
      }
    }
    directory ??= await resolveStateDirectory(stateDirectory)
    const lock = tryAcquireSyncLock(directory)
    if (lock) return { directory, lock }
    if (diagnostics.getStatus().phase !== 'waiting_lock') logRuntime({ status: 'waiting_for_lock' })
    diagnostics.update({ phase: 'waiting_lock', failure: null, retryAt: null })
    await Bun.sleep(1_000)
  }
}

export function reportBlocked(
  error: unknown, diagnostics: Diagnostics, fallback: { stage: 'center' | 'mapping' | 'run'; code: string },
): void {
  const failure = error instanceof GatewayFailure
    ? { stage: error.stage, code: error.code, httpStatus: error.httpStatus }
    : error instanceof SyncFailure ? { stage: error.stage, code: error.code }
    : error instanceof StateError ? { stage: 'state' as const, code: error.code }
    : fallback
  diagnostics.update({ phase: 'blocked', failure, retryAt: null })
  logRuntime({ status: 'blocked', ...failure })
}
