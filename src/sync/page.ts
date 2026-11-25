import { postUsageBatch } from '../gateway/client.ts'
import { splitUsageBatches, type ReportRow } from './mapping.ts'

export async function reportPage(
  center: URL,
  key: string,
  rows: readonly ReportRow[],
  nextCursor: string,
  timeoutMs: number,
): Promise<{ nextCursor: string; accepted: number; skipped: number }> {
  let accepted = 0
  let skipped = 0
  for (const batch of splitUsageBatches(rows)) {
    const receipt = await postUsageBatch(center, key, batch.body, batch.rids, timeoutMs)
    accepted += receipt.accepted
    skipped += receipt.skipped
  }
  return { nextCursor, accepted, skipped }
}
