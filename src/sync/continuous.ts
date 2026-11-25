import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { GatewayFailure, readGatewayPid, readUsagePage } from '../gateway/client.ts'
import type { SyncOptions } from '../options.ts'
import { tryAcquireSyncLock } from '../state/lock.ts'
import { openSyncState, saveSyncProgress, StateError, type SyncBinding } from '../state/store.ts'
import { mapUsageRow, MappingFailure, type ReportRow } from './mapping.ts'
import { reportPage } from './page.ts'

const maxPages = 5
const roundBudgetMs = 30_000
const maxRetryDelayMs = 900_000
const retryableCodes = new Set(['network_error', 'timeout', 'rate_limited', 'upstream_failure'])

class SyncFailure extends Error {
  constructor(readonly stage: 'source' | 'center' | 'state', readonly code: string) {
    super(code)
  }
}

function log(event: { status: string; [field: string]: unknown }): void {
  const output = event.status === 'blocked' || event.status === 'retrying' ? console.warn : console.info
  output('[magpie-usage-hub]', JSON.stringify(event))
}

async function waitForRetry(error: unknown, failures: number): Promise<void> {
  if (!(error instanceof GatewayFailure) || !retryableCodes.has(error.code)) throw error
  const backoffMs = Math.min(maxRetryDelayMs, 10_000 * 2 ** Math.min(failures, 7))
  const localDelayMs = Math.min(maxRetryDelayMs, backoffMs + Math.floor(backoffMs * 0.25 * Math.random()))
  const delayMs = Math.max(localDelayMs, error.retryAfterMs ?? 0)
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

async function waitForGatewayOwner(source: URL, timeoutMs: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      await checkGatewayOwner(source, timeoutMs)
      return
    } catch (error) {
      await waitForRetry(error, failures)
    }
  }
}

async function resolveStateDirectory(directory: string): Promise<string> {
  const pluginDirectory = join(directory, 'magpie-usage-hub')
  try {
    await mkdir(pluginDirectory, { recursive: true, mode: 0o700 })
    return await realpath(pluginDirectory)
  } catch {
    throw new SyncFailure('state', 'state_directory_unavailable')
  }
}

async function readReportingKey(path: string): Promise<string> {
  let key: string
  try {
    key = (await readFile(path, 'utf8')).trim()
  } catch {
    throw new SyncFailure('center', 'key_file_unreadable')
  }
  if (!/^[\x21-\x7e]+$/.test(key)) throw new SyncFailure('center', 'invalid_key_file')
  return key
}

async function poll(directory: string, options: SyncOptions, timeoutMs: number): Promise<void> {
  const binding: SyncBinding = {
    sourceGatewayUrl: options.sourceGatewayUrl.href,
    sourceCallerKeyId: options.sourceCallerKeyId,
    centralGatewayUrl: options.centralGatewayUrl.href,
    initialMode: options.initialMode,
  }
  let state = await openSyncState(directory, binding)
  if (state.cursor !== null) log({ status: 'resumed' })

  let failures = 0
  while (true) {
    const roundStarted = performance.now()
    try {
      await checkGatewayOwner(options.sourceGatewayUrl, timeoutMs)
      for (let pages = 0; pages < maxPages; pages += 1) {
        const initializing = state.cursor === null
        const cursor = state.cursor ?? options.initialMode
        const page = await readUsagePage(options.sourceGatewayUrl, cursor, options.sourceCallerKeyId, timeoutMs)
        const hasChanges = page.hasMore || page.rows.length > 0 || page.deletedCount > 0
        if (hasChanges && ((initializing && cursor === 'now') || page.nextCursor === cursor)) {
          throw new GatewayFailure('source', 'invalid_source_page')
        }

        const reports: ReportRow[] = []
        for (const row of page.rows) {
          const report = mapUsageRow(row, state.sourceInstanceId, options.sourceCallerKeyId)
          if (report !== null) reports.push(report)
        }

        const receipt = reports.length === 0 ? undefined : await reportPage(
          options.centralGatewayUrl, await readReportingKey(options.centralKeyFile), reports, page.nextCursor, timeoutMs,
        )
        state = await saveSyncProgress(directory, state, page.nextCursor)
        if (initializing) log({ status: 'ready' })
        if (receipt !== undefined) {
          log({ status: 'confirmed', accepted: receipt.accepted, skipped: receipt.skipped, hasMore: page.hasMore })
        }
        failures = 0
        if (!page.hasMore || performance.now() - roundStarted >= roundBudgetMs) break
      }
      await Bun.sleep(options.pollIntervalSec * 1_000)
    } catch (error) {
      await waitForRetry(error, failures)
      failures += 1
    }
  }
}

function reportBlocked(error: unknown): void {
  if (error instanceof GatewayFailure || error instanceof SyncFailure) {
    log({ status: 'blocked', stage: error.stage, code: error.code,
      httpStatus: error instanceof GatewayFailure ? error.httpStatus : undefined })
  } else if (error instanceof StateError) {
    log({ status: 'blocked', stage: 'state', code: error.code })
  } else if (error instanceof MappingFailure) {
    log({ status: 'blocked', stage: 'mapping', code: error.code })
  } else {
    log({ status: 'blocked', stage: 'run', code: 'unexpected_failure' })
  }
}

export async function runContinuousSync(root: string, options: SyncOptions): Promise<void> {
  const timeoutMs = options.requestTimeoutSec * 1_000
  try {
    await waitForGatewayOwner(options.sourceGatewayUrl, timeoutMs)
    const directory = await resolveStateDirectory(root)
    let lock = tryAcquireSyncLock(directory)
    if (lock === undefined) log({ status: 'waiting_for_lock' })
    while (lock === undefined) {
      await Bun.sleep(1_000)
      await waitForGatewayOwner(options.sourceGatewayUrl, timeoutMs)
      lock = tryAcquireSyncLock(directory)
    }
    try {
      await poll(directory, options, timeoutMs)
    } finally {
      lock.release()
    }
  } catch (error) {
    reportBlocked(error)
  }
}
