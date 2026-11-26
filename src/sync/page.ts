import { GatewayFailure, postUsageBatch } from '../gateway/client.ts'
import { splitUsageBatches, type ReportRow } from './mapping.ts'

export async function reportPage(
  center: URL,
  key: string,
  rows: readonly ReportRow[],
  nextCursor: string,
  timeoutMs: number,
  direct = false,
): Promise<{ nextCursor: string; accepted: number; skipped: number }> {
  let accepted = 0
  let skipped = 0

  async function sendRows(batchRows: readonly ReportRow[]): Promise<void> {
    let offset = 0
    for (const batch of splitUsageBatches(batchRows)) {
      const count = batch.rids.length
      try {
        const receipt = await postUsageBatch(center, key, batch.body, batch.rids, timeoutMs, direct)
        accepted += receipt.accepted
        skipped += receipt.skipped
      } catch (error) {
        if (!(error instanceof GatewayFailure) || error.code !== 'batch_too_large' || count === 1) throw error
        const midpoint = offset + Math.floor(count / 2)
        await sendRows(batchRows.slice(offset, midpoint))
        await sendRows(batchRows.slice(midpoint, offset + count))
      }
      offset += count
    }
  }

  await sendRows(rows)
  return { nextCursor, accepted, skipped }
}
