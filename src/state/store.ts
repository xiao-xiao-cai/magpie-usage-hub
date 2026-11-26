import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isProviderId } from '../options.ts'
import { decodeRecoveryRequest, type RecoveryRequest } from '../recovery.ts'
import { StateError } from './errors.ts'

export { StateError } from './errors.ts'

const identityVersion = 1
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const windowsRenameRetryDelaysMs = [10, 25, 50, 100] as const

export type SyncBinding = Readonly<{
  sourceGatewayUrl: string
  sourceCallerKeyId: string
  sourceProviderId?: string
  centralGatewayUrl: string
  initialMode: 'now' | 'start'
}>

type Identity = Readonly<{ version: typeof identityVersion; sourceInstanceId: string }>

type RecoveryCounts = Readonly<{ pages: number; accepted: number; skipped: number }>

export type RecoveryProgress = RecoveryCounts & Readonly<{
  request: RecoveryRequest
  cursor: string | null
  lastConfirmedAt: string | null
}>

const recoveryRejectionCodes = [
  'recovery_binding_mismatch', 'recovery_no_checkpoint', 'recovery_busy',
  'recovery_cursor_valid', 'recovery_cursor_incompatible',
] as const

export type RecoveryRejectionCode = typeof recoveryRejectionCodes[number]

const recoveryScanFailureCodes = ['recovery_scan_cursor_expired', 'recovery_scan_cursor_reset'] as const

export type RecoveryScanFailureCode = typeof recoveryScanFailureCodes[number]

export type RecoveryResult = Readonly<{ request: RecoveryRequest }> & (
  | (RecoveryCounts & Readonly<{ status: 'complete'; lastConfirmedAt: string }>)
  | (RecoveryCounts & Readonly<{
    status: 'failed'
    reason: RecoveryScanFailureCode
    lastConfirmedAt: string | null
    failedAt: string
  }>)
  | Readonly<{ status: 'rejected'; reason: RecoveryRejectionCode }>
)

type RecoveryState = Readonly<{ active: RecoveryProgress | null; results: readonly RecoveryResult[] }>

export type SyncState = Readonly<{
  version: 1 | 2
  sourceInstanceId: string
  binding: SyncBinding
  cursor: string | null
  lastConfirmedAt: string | null
  recovery?: RecoveryState
}>

type StateFile = 'identity.json' | 'state.json'

export type WriteOperations = {
  sync(file: FileHandle): Promise<void>
  rename(source: string, target: string): Promise<void>
}

const writeOperations: WriteOperations = { sync: file => file.sync(), rename }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && value !== 'now' && value !== 'start'
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function readSourceInstanceId(value: unknown): string {
  if (typeof value !== 'string' || !uuidV4.test(value)) throw new StateError('state_invalid')
  return value
}

function readIdentity(value: unknown): Identity {
  if (!isObject(value) || !Number.isSafeInteger(value.version)) throw new StateError('state_invalid')
  if (value.version !== identityVersion) throw new StateError('state_version_unsupported')
  return { version: identityVersion, sourceInstanceId: readSourceInstanceId(value.sourceInstanceId) }
}

function readBinding(value: unknown): SyncBinding {
  if (!isObject(value)) throw new StateError('state_invalid')
  const { sourceGatewayUrl, sourceCallerKeyId, sourceProviderId, centralGatewayUrl, initialMode } = value
  if (!isText(sourceGatewayUrl) || !isText(sourceCallerKeyId) || !isText(centralGatewayUrl)
    || (sourceProviderId !== undefined && !isProviderId(sourceProviderId))
    || (initialMode !== 'now' && initialMode !== 'start')) {
    throw new StateError('state_invalid')
  }
  return { sourceGatewayUrl, sourceCallerKeyId, centralGatewayUrl, initialMode,
    ...(sourceProviderId === undefined ? {} : { sourceProviderId }),
  }
}

function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new StateError('state_invalid')
  return value
}

function readRecoveryCounts(value: Record<string, unknown>): RecoveryCounts {
  return { pages: readCount(value.pages), accepted: readCount(value.accepted), skipped: readCount(value.skipped) }
}

function readProgressConfirmation(value: unknown, counts: RecoveryCounts): string | null {
  if (counts.pages > 0 && isTimestamp(value)) return value
  if (counts.pages === 0 && value === null && counts.accepted === 0 && counts.skipped === 0) return null
  throw new StateError('state_invalid')
}

function readStoredRequest(value: unknown): RecoveryRequest {
  try {
    return decodeRecoveryRequest(value)
  } catch {
    throw new StateError('state_invalid')
  }
}

function readActiveRecovery(value: unknown, binding: SyncBinding): RecoveryProgress | null {
  if (value === null) return null
  if (!isObject(value)) throw new StateError('state_invalid')
  const request = readStoredRequest(value.request)
  const counts = readRecoveryCounts(value)
  const { cursor } = value
  const lastConfirmedAt = readProgressConfirmation(value.lastConfirmedAt, counts)
  if (!sameBinding(request.binding, binding)) throw new StateError('state_invalid')
  if ((cursor === null && lastConfirmedAt === null) || (isCursor(cursor) && lastConfirmedAt !== null)) {
    return { request, ...counts, cursor, lastConfirmedAt }
  }
  throw new StateError('state_invalid')
}

function readRecoveryResult(value: unknown, binding: SyncBinding, version: SyncState['version']): RecoveryResult {
  if (!isObject(value)) throw new StateError('state_invalid')
  const request = readStoredRequest(value.request)
  if (value.status === 'rejected') {
    const reason = recoveryRejectionCodes.find(code => code === value.reason)
    if (reason !== undefined) return { request, status: 'rejected', reason }
  }
  if (version === 2 && sameBinding(request.binding, binding)
    && (value.status === 'complete' || value.status === 'failed')) {
    const counts = readRecoveryCounts(value)
    const lastConfirmedAt = readProgressConfirmation(value.lastConfirmedAt, counts)
    if (value.status === 'complete' && lastConfirmedAt !== null) {
      return { request, status: 'complete', ...counts, lastConfirmedAt }
    }
    if (value.status === 'failed' && isTimestamp(value.failedAt)) {
      const reason = recoveryScanFailureCodes.find(code => code === value.reason)
      if (reason !== undefined) {
        return { request, status: 'failed', reason, ...counts, lastConfirmedAt, failedAt: value.failedAt }
      }
    }
  }
  throw new StateError('state_invalid')
}

function readRecoveryState(value: unknown, state: SyncState): RecoveryState | undefined {
  if (value === undefined && state.version === 1) return undefined
  if (!isObject(value) || !Array.isArray(value.results)) throw new StateError('state_invalid')
  const active = readActiveRecovery(value.active, state.binding)
  if ((active && state.version === 1) || (state.version === 2 && state.cursor === null)) {
    throw new StateError('state_invalid')
  }
  const results = value.results.map((result: unknown) => readRecoveryResult(result, state.binding, state.version))
  const ids = results.map(result => result.request.id)
  if (active) ids.push(active.request.id)
  if (new Set(ids).size !== ids.length || ids.length === 0
    || (state.version === 2 && active === null && results.every(result => result.status === 'rejected'))) {
    throw new StateError('state_invalid')
  }
  return { active, results }
}

function readState(value: unknown): SyncState {
  if (!isObject(value) || !Number.isSafeInteger(value.version)) throw new StateError('state_invalid')
  const { cursor, lastConfirmedAt, version } = value
  if (version !== 1 && version !== 2) throw new StateError('state_version_unsupported')
  if ((cursor !== null && !isCursor(cursor)) || (lastConfirmedAt !== null && !isTimestamp(lastConfirmedAt))
    || (cursor === null) !== (lastConfirmedAt === null)) {
    throw new StateError('state_invalid')
  }
  const state: SyncState = {
    version,
    sourceInstanceId: readSourceInstanceId(value.sourceInstanceId),
    binding: readBinding(value.binding),
    cursor,
    lastConfirmedAt,
  }
  const recovery = readRecoveryState(value.recovery, state)
  return recovery === undefined ? state : { ...state, recovery }
}

export function sameBinding(stored: SyncBinding, proposed: SyncBinding): boolean {
  return stored.sourceGatewayUrl === proposed.sourceGatewayUrl
    && stored.sourceCallerKeyId === proposed.sourceCallerKeyId
    && stored.sourceProviderId === proposed.sourceProviderId
    && stored.centralGatewayUrl === proposed.centralGatewayUrl
    && stored.initialMode === proposed.initialMode
}

async function readJson(directory: string, name: StateFile): Promise<unknown> {
  const path = join(directory, name)
  try {
    const file = await lstat(path)
    if (!file.isFile()) throw new StateError('state_invalid')
  } catch (error) {
    if (error instanceof StateError) throw error
    if (isObject(error) && error.code === 'ENOENT') return undefined
    throw new StateError('state_read_failed')
  }

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new StateError('state_read_failed')
  }
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    throw new StateError('state_invalid')
  }
}

export async function writeStateJson(
  directory: string, name: StateFile | 'registration.json', value: object, operations = writeOperations,
): Promise<void> {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`)
  let created = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    created = true
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await operations.sync(file)
    } finally {
      await file.close()
    }
    const target = join(directory, name)
    for (let attempt = 0; ; attempt += 1) {
      try {
        await operations.rename(temporary, target)
        break
      } catch (error) {
        const delayMs = windowsRenameRetryDelaysMs[attempt]
        const code = isObject(error) ? error.code : undefined
        if (process.platform !== 'win32' || delayMs === undefined
          || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
        await Bun.sleep(delayMs)
      }
    }
  } catch {
    if (created) await unlink(temporary).catch(() => {})
    throw new StateError('state_write_failed')
  }
}

async function readStorage(directory: string): Promise<{ state: SyncState | undefined; hasIdentity: boolean }> {
  const savedState = await readJson(directory, 'state.json')
  const state = savedState === undefined ? undefined : readState(savedState)
  const savedIdentity = await readJson(directory, 'identity.json')
  const identity = savedIdentity === undefined ? undefined : readIdentity(savedIdentity)
  if (identity && identity.sourceInstanceId !== state?.sourceInstanceId) throw new StateError('identity_mismatch')
  return { state, hasIdentity: identity !== undefined }
}

export async function readStoredSyncState(directory: string): Promise<SyncState | undefined> {
  const { state } = await readStorage(directory)
  return state
}

export async function openSyncState(
  directory: string, proposed: SyncBinding,
  { requireExisting = false, sourceInstanceId: expectedId }: { requireExisting?: boolean; sourceInstanceId?: string } = {},
): Promise<SyncState> {
  const binding = readBinding(proposed)
  const { state, hasIdentity } = await readStorage(directory)

  if (state) {
    if (expectedId !== undefined && state.sourceInstanceId !== expectedId) throw new StateError('identity_mismatch')
    if (!sameBinding(state.binding, binding)) throw new StateError('binding_mismatch')
    if (!hasIdentity) {
      await writeStateJson(directory, 'identity.json', { version: identityVersion, sourceInstanceId: state.sourceInstanceId })
    }
    return state
  }
  if (requireExisting) throw new StateError('recovery_no_checkpoint')

  const sourceInstanceId = expectedId === undefined ? randomUUID() : readSourceInstanceId(expectedId)
  const initialState: SyncState = { version: 1, sourceInstanceId, binding, cursor: null, lastConfirmedAt: null }
  await writeStateJson(directory, 'state.json', initialState)
  await writeStateJson(directory, 'identity.json', { version: identityVersion, sourceInstanceId })
  return initialState
}

export async function saveSyncProgress(
  directory: string, state: SyncState, nextCursor: string, operations = writeOperations,
): Promise<SyncState> {
  if (!isCursor(nextCursor) || state.recovery?.active) throw new StateError('state_invalid')
  const nextState = { ...state, cursor: nextCursor, lastConfirmedAt: new Date().toISOString() }
  await writeStateJson(directory, 'state.json', nextState, operations)
  return nextState
}

export async function saveRecoveryState(
  directory: string, state: SyncState, operations = writeOperations,
): Promise<SyncState> {
  const validated = readState(state)
  await writeStateJson(directory, 'state.json', validated, operations)
  return validated
}
