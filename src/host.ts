import { mkdir, realpath } from 'node:fs/promises'
import type { Diagnostics } from './diagnostics.ts'
import { GatewayFailure, readGatewayPid } from './gateway/client.ts'
import { StateError } from './state/errors.ts'
import { tryAcquireSyncLock } from './state/lock.ts'

const maxRetryDelayMs = 900_000

export function logRuntime(event: { status: string; [field: string]: unknown }): void {
  const output = event.status === 'blocked' || event.status === 'retrying' ? console.warn : console.info
  output('[magpie-usage-hub]', JSON.stringify(event))
}

async function waitForRetry(error: unknown, failures: number, diagnostics: Diagnostics): Promise<void> {
  if (!(error instanceof GatewayFailure) || (error.code !== 'unavailable' && error.code !== 'timeout')) throw error
  const backoffMs = Math.min(maxRetryDelayMs, 10_000 * 2 ** Math.min(failures, 7))
  const delayMs = Math.min(maxRetryDelayMs, backoffMs + Math.floor(backoffMs * 0.25 * Math.random()))
  const problem = { stage: 'center' as const, code: error.code, httpStatus: error.httpStatus }
  diagnostics.update({ phase: 'retrying',
    failure: problem, retryAt: new Date(Date.now() + delayMs).toISOString(),
  })
  logRuntime({ status: 'retrying', ...problem, delayMs })
  await Bun.sleep(delayMs)
}

async function checkGatewayOwner(gateway: URL, timeoutMs: number): Promise<void> {
  const pid = await readGatewayPid(gateway, timeoutMs)
  if (pid !== process.ppid) throw new GatewayFailure('center_owner_mismatch')
}

async function resolveStateDirectory(directory: string): Promise<string> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return await realpath(directory)
  } catch {
    throw new StateError('state_directory_unavailable')
  }
}

export async function acquireGatewayLock(
  stateDirectory: string, gateway: URL, timeoutMs: number, diagnostics: Diagnostics,
) {
  let directory: string | undefined
  for (;;) {
    for (let failures = 0; ; failures += 1) {
      try {
        diagnostics.update({ lastAttemptAt: new Date().toISOString() })
        await checkGatewayOwner(gateway, timeoutMs)
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
  error: unknown, diagnostics: Diagnostics, fallback: string,
): void {
  const failure = error instanceof GatewayFailure
    ? { stage: 'center' as const, code: error.code, httpStatus: error.httpStatus }
    : error instanceof StateError ? { stage: 'state' as const, code: error.code }
    : { stage: 'center' as const, code: fallback }
  diagnostics.update({ phase: 'blocked', failure, retryAt: null })
  logRuntime({ status: 'blocked', ...failure })
}
