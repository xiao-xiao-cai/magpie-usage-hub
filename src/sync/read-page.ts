import { readFile } from 'node:fs/promises'
import { GatewayFailure, readUsagePage, type UsagePage } from '../gateway/client.ts'
import type { SyncOptions } from '../options.ts'
import { mapUsageRow, type ReportRow } from './mapping.ts'
import { reportPage } from './page.ts'

export class SyncFailure extends Error {
  constructor(readonly stage: 'source' | 'center' | 'state', readonly code: string) {
    super(code)
  }
}

export async function readValidatedPage(options: SyncOptions, cursor: string, timeoutMs: number): Promise<UsagePage> {
  const page = await readUsagePage(options.sourceGatewayUrl, cursor, options.sourceCallerKeyId, timeoutMs)
  const hasChanges = page.hasMore || page.rows.length > 0 || page.deletedCount > 0
  if (hasChanges && (cursor === 'now' || page.nextCursor === cursor)) {
    throw new GatewayFailure('source', 'invalid_source_page')
  }
  return page
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

export async function sendUsagePage(
  options: SyncOptions, page: UsagePage, sourceInstanceId: string, timeoutMs: number,
  includesTime?: (timestamp: string) => boolean,
): Promise<{ accepted: number; skipped: number }> {
  const reports: ReportRow[] = []
  for (const row of page.rows) {
    const report = mapUsageRow(row, sourceInstanceId, options.sourceCallerKeyId, includesTime)
    if (report !== null) reports.push(report)
  }
  if (reports.length === 0) return { accepted: 0, skipped: 0 }
  const key = await readReportingKey(options.centralKeyFile)
  const { accepted, skipped } = await reportPage(options.centralGatewayUrl, key, reports, page.nextCursor, timeoutMs)
  return { accepted, skipped }
}
