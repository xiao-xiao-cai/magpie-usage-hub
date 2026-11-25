import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { StateError } from './errors.ts'

export { StateError } from './errors.ts'

const version = 1
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const windowsRenameRetryDelaysMs = [10, 25, 50, 100] as const

export type SyncBinding = Readonly<{
  sourceGatewayUrl: string
  sourceCallerKeyId: string
  centralGatewayUrl: string
  initialMode: 'now' | 'start'
}>

type Identity = Readonly<{ version: typeof version; sourceInstanceId: string }>

export type SyncState = Identity & Readonly<{
  binding: SyncBinding
  cursor: string | null
  lastConfirmedAt: string | null
}>

type StateFile = 'identity.json' | 'state.json'

type WriteOperations = {
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

function readIdentity(value: unknown): Identity {
  if (!isObject(value) || !Number.isSafeInteger(value.version)) throw new StateError('state_invalid')
  if (value.version !== version) throw new StateError('state_version_unsupported')
  if (typeof value.sourceInstanceId !== 'string' || !uuidV4.test(value.sourceInstanceId)) {
    throw new StateError('state_invalid')
  }
  return { version, sourceInstanceId: value.sourceInstanceId }
}

function readBinding(value: unknown): SyncBinding {
  if (!isObject(value)) throw new StateError('state_invalid')
  const { sourceGatewayUrl, sourceCallerKeyId, centralGatewayUrl, initialMode } = value
  if (!isText(sourceGatewayUrl) || !isText(sourceCallerKeyId) || !isText(centralGatewayUrl)
    || (initialMode !== 'now' && initialMode !== 'start')) {
    throw new StateError('state_invalid')
  }
  return { sourceGatewayUrl, sourceCallerKeyId, centralGatewayUrl, initialMode }
}

function readState(value: unknown): SyncState {
  if (!isObject(value)) throw new StateError('state_invalid')
  const identity = readIdentity(value)
  const { cursor, lastConfirmedAt } = value
  if ((cursor !== null && !isCursor(cursor)) || (lastConfirmedAt !== null && !isTimestamp(lastConfirmedAt))
    || (cursor === null) !== (lastConfirmedAt === null)) {
    throw new StateError('state_invalid')
  }
  return { ...identity, binding: readBinding(value.binding), cursor, lastConfirmedAt }
}

function sameBinding(stored: SyncBinding, proposed: SyncBinding): boolean {
  return stored.sourceGatewayUrl === proposed.sourceGatewayUrl
    && stored.sourceCallerKeyId === proposed.sourceCallerKeyId
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

async function writeJson(
  directory: string, name: StateFile, value: Identity | SyncState, operations = writeOperations,
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

export async function openSyncState(directory: string, proposed: SyncBinding): Promise<SyncState> {
  const binding = readBinding(proposed)
  const savedState = await readJson(directory, 'state.json')
  const state = savedState === undefined ? undefined : readState(savedState)
  const savedIdentity = await readJson(directory, 'identity.json')
  const identity = savedIdentity === undefined ? undefined : readIdentity(savedIdentity)

  if (state) {
    if (!sameBinding(state.binding, binding)) throw new StateError('binding_mismatch')
    if (identity && identity.sourceInstanceId !== state.sourceInstanceId) throw new StateError('identity_mismatch')
    if (!identity) {
      await writeJson(directory, 'identity.json', { version, sourceInstanceId: state.sourceInstanceId })
    }
    return state
  }
  if (identity) throw new StateError('identity_mismatch')

  const sourceInstanceId = randomUUID()
  const initialState: SyncState = { version, sourceInstanceId, binding, cursor: null, lastConfirmedAt: null }
  await writeJson(directory, 'state.json', initialState)
  await writeJson(directory, 'identity.json', { version, sourceInstanceId })
  return initialState
}

export async function saveSyncProgress(
  directory: string, state: SyncState, nextCursor: string, operations = writeOperations,
): Promise<SyncState> {
  if (!isCursor(nextCursor)) throw new StateError('state_invalid')
  const nextState = { ...state, cursor: nextCursor, lastConfirmedAt: new Date().toISOString() }
  await writeJson(directory, 'state.json', nextState, operations)
  return nextState
}
