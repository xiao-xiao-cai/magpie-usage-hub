import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GatewayFailure, readUsagePage } from './gateway/client.ts'
import type { TestOptions } from './options.ts'
import { mapUsageRow, MappingFailure, type ReportRow } from './sync/mapping.ts'
import { reportPage } from './sync/page.ts'

const requestTimeoutMs = 30_000

type RunFailure = {
  status: 'failed'
  stage: 'run' | 'source' | 'mapping' | 'center'
  code: string
  httpStatus?: number
}

type RunResult = RunFailure | { status: 'confirmed'; rid: string; accepted: number; skipped: number }

async function claimRun(directory: string, runId: string): Promise<string | null> {
  const runs = join(directory, 'magpie-usage-hub', 'phase1')
  await mkdir(runs, { recursive: true })
  const runDirectory = join(runs, runId)
  try {
    await mkdir(runDirectory)
    return runDirectory
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') return null
    throw error
  }
}

async function syncTestCall(options: TestOptions): Promise<RunResult> {
  const page = await readUsagePage(options.sourceGatewayUrl, options.sourceCursor, options.sourceCallerKeyId, requestTimeoutMs)
  if (page.hasMore) return { status: 'failed', stage: 'source', code: 'test_page_has_more' }
  const eligible: ReportRow[] = []
  for (const row of page.rows) {
    const report = mapUsageRow(row, options.sourceId, options.sourceCallerKeyId)
    if (report !== null) eligible.push(report)
  }
  if (eligible.length !== 1) return { status: 'failed', stage: 'source', code: 'expected_one_test_row' }

  let key: string
  try {
    key = (await readFile(options.centralKeyFile, 'utf8')).trim()
  } catch {
    return { status: 'failed', stage: 'center', code: 'key_file_unreadable' }
  }
  if (!/^[\x21-\x7e]+$/.test(key)) return { status: 'failed', stage: 'center', code: 'invalid_key_file' }

  const receipt = await reportPage(options.centralGatewayUrl, key, eligible, page.nextCursor, requestTimeoutMs)
  return { status: 'confirmed', rid: eligible[0].rid, accepted: receipt.accepted, skipped: receipt.skipped }
}

function summarizeFailure(error: unknown): RunFailure {
  if (error instanceof GatewayFailure) {
    return { status: 'failed', stage: error.stage, code: error.code, httpStatus: error.httpStatus }
  }
  if (error instanceof MappingFailure) return { status: 'failed', stage: 'mapping', code: error.code }
  return { status: 'failed', stage: 'run', code: 'unexpected_failure' }
}

export async function runTestOnce(directory: string, options: TestOptions): Promise<RunResult | null> {
  let runDirectory: string | null
  try {
    runDirectory = await claimRun(directory, options.runId)
  } catch {
    return { status: 'failed', stage: 'run', code: 'claim_unavailable' }
  }
  if (runDirectory === null) return null

  let result: RunResult
  try {
    result = await syncTestCall(options)
  } catch (error) {
    result = summarizeFailure(error)
  }

  try {
    await writeFile(join(runDirectory, 'result.json'), `${JSON.stringify(result)}\n`, { flag: 'wx', mode: 0o600 })
  } catch {
    console.warn('[magpie-usage-hub] result_file_unwritable')
  }
  return result
}
