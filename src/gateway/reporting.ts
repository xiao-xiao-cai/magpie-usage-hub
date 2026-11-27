import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isRecord, readBoundedJson } from '../center/http.ts'
import { ingestPaths, ProtocolFailure, readCheckpoint, readPageReceipt,
  type Checkpoint, type PageReceipt, type PageSubmission, type RecoveryReport } from '../sync/protocol.ts'
import { requestDirect } from './direct.ts'

const responseLimit = 16 * 1024

export class ReportingFailure extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) { super(code) }
}

async function readReportKey(path: string) {
  try {
    if (!(await lstat(path)).isFile()) throw new ReportingFailure('report_key_file_invalid')
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const file = await open(path, flags)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size !== 64 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
        throw new ReportingFailure('report_key_file_invalid')
      }
      const bytes = Buffer.alloc(65)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      const token = bytes.subarray(0, bytesRead).toString('latin1')
      if (bytesRead !== 64 || !/^[a-f0-9]{64}$/u.test(token)) throw new ReportingFailure('report_key_file_invalid')
      return token
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof ReportingFailure) throw error
    throw new ReportingFailure('report_key_file_unavailable')
  }
}

export type ReportingTarget = {
  checkpoint(): Checkpoint | Promise<Checkpoint>
  commit(page: PageSubmission): PageReceipt | Promise<PageReceipt>
  recover(report: RecoveryReport): Checkpoint | Promise<Checkpoint>
}

export async function openReportingTarget(baseUrl: URL, keyFile: string, timeoutMs: number): Promise<ReportingTarget> {
  const key = await readReportKey(keyFile)

  async function call(path: string, body?: PageSubmission | RecoveryReport) {
    const signal = AbortSignal.timeout(timeoutMs)
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
    if (body) headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await requestDirect(new URL(path, baseUrl), {
        method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      }, signal)
    } catch {
      throw new ReportingFailure(signal.aborted ? 'timeout' : 'unavailable')
    }
    const { status } = response
    if (status >= 300 && status < 400) {
      void response.body?.cancel().catch(() => {})
      throw new ReportingFailure('redirect', status)
    }
    let payload: unknown
    try {
      payload = await readBoundedJson(response, responseLimit)
    } catch {
      if (signal.aborted) throw new ReportingFailure('timeout', status)
    }
    if (status === 200) {
      if (payload === undefined) throw new ReportingFailure('invalid_center_response', status)
      return payload
    }
    const code = isRecord(payload) && isRecord(payload.error) ? payload.error.code : null
    if (status === 401) throw new ReportingFailure('report_key_invalid', status)
    if (status === 403) throw new ReportingFailure(code === 'source_paused' ? code : 'source_mismatch', status)
    if (status === 409 && (code === 'checkpoint_conflict' || code === 'source_recovery_required')) {
      throw new ReportingFailure(code, status)
    }
    if (status === 429) throw new ReportingFailure('rate_limited', status)
    throw new ReportingFailure(status >= 500 ? 'unavailable' : 'center_rejected_page', status)
  }

  async function decode<T>(value: Promise<unknown>, read: (payload: unknown) => T) {
    try {
      return read(await value)
    } catch (error) {
      if (error instanceof ProtocolFailure) throw new ReportingFailure(error.code)
      throw error
    }
  }

  return {
    checkpoint: () => decode(call(ingestPaths.checkpoint), readCheckpoint),
    commit: page => decode(call(ingestPaths.pages, page), payload => readPageReceipt(payload, page)),
    recover: report => decode(call(ingestPaths.recovery, report), readCheckpoint),
  }
}
