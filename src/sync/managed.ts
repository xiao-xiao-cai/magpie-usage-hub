import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { type Diagnostics, updateDiagnosticProgress } from '../diagnostics.ts'
import { GatewayFailure, pairManagedSource, readManagedConfig } from '../gateway/client.ts'
import { readConfigRevision, type ManagedSourceOptions, type RuntimeSyncOptions } from '../options.ts'
import { readStoredSyncState, StateError, writeStateJson } from '../state/store.ts'
import { SyncFailure } from './read-page.ts'

const registrationFile = 'registration.json'
const bearerPattern = /^[0-9a-f]{64}$/

type Registration = {
  version: 1
  sourceGatewayUrl: string
  centralGatewayUrl: string
  key: string
  sourceInstanceId: string | null
}

async function readProtectedText(path: string): Promise<string | undefined> {
  const entry = await lstat(path, { throwIfNoEntry: false })
  if (!entry) return undefined
  if (!entry.isFile()) throw new Error('invalid_file')
  const windows = process.platform === 'win32'
  const file = await open(path, constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 4_096 || (!windows && (metadata.mode & 0o077) !== 0)) {
      throw new Error('invalid_file')
    }
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

async function readRegistration(directory: string): Promise<Registration | undefined> {
  try {
    const text = await readProtectedText(join(directory, registrationFile))
    if (text === undefined) return undefined
    const raw: unknown = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_registration')
    const value: Record<string, unknown> = Object.fromEntries(Object.entries(raw))
    const { version, sourceGatewayUrl, centralGatewayUrl, key, sourceInstanceId } = value
    const id = readConfigRevision(sourceInstanceId)
    if (version !== 1 || typeof sourceGatewayUrl !== 'string' || typeof centralGatewayUrl !== 'string'
      || typeof key !== 'string' || key.length !== 64 || !bearerPattern.test(key) || (id === null && sourceInstanceId !== null)) {
      throw new Error('invalid_registration')
    }
    return { version, sourceGatewayUrl, centralGatewayUrl, key, sourceInstanceId: id }
  } catch {
    throw new SyncFailure('state', 'managed_credential_invalid')
  }
}

async function readPairingCode(path: string | undefined): Promise<string> {
  if (path === undefined) throw new SyncFailure('center', 'pairing_code_required')
  try {
    const code = (await readProtectedText(path))?.trim()
    if (code === undefined || !bearerPattern.test(code)) throw new Error('invalid_pairing_code')
    return code
  } catch {
    throw new SyncFailure('center', 'invalid_pairing_code_file')
  }
}

export async function openManagedSource(directory: string, local: ManagedSourceOptions, diagnostics: Diagnostics) {
  const stored = await readStoredSyncState(directory)
  const saved = await readRegistration(directory)
  const sourceGatewayUrl = local.sourceGatewayUrl.href
  const centralGatewayUrl = local.centralGatewayUrl.href
  if (stored && !saved) throw new SyncFailure('state', 'managed_credential_missing')
  if (saved && (saved.sourceGatewayUrl !== sourceGatewayUrl || saved.centralGatewayUrl !== centralGatewayUrl)) {
    throw new StateError('binding_mismatch')
  }
  if (stored && stored.sourceInstanceId !== saved?.sourceInstanceId) throw new StateError('identity_mismatch')
  if (stored) updateDiagnosticProgress(diagnostics, stored)
  if (!saved && local.pairingCodeFile === undefined) throw new SyncFailure('center', 'pairing_code_required')
  let registration: Registration = saved ?? {
    version: 1, sourceGatewayUrl, centralGatewayUrl, key: randomBytes(32).toString('hex'), sourceInstanceId: null,
  }
  if (!saved) await writeStateJson(directory, registrationFile, registration)
  if (registration.sourceInstanceId === null) diagnostics.update({ phase: 'pairing' })
  else diagnostics.update({ credentialConfigured: true })

  const timeoutMs = local.requestTimeoutSec * 1_000
  const readConfiguration = () => readManagedConfig(local.centralGatewayUrl, registration.key, timeoutMs)
  return async () => {
    let config
    try {
      config = await readConfiguration()
    } catch (error) {
      if (registration.sourceInstanceId !== null || !(error instanceof GatewayFailure) || error.code !== 'unauthorized') throw error
      diagnostics.update({ phase: 'pairing', failure: null, retryAt: null })
      const code = await readPairingCode(local.pairingCodeFile)
      const digest = createHash('sha256').update(registration.key).digest('hex')
      let pairingRejected = false
      try {
        await pairManagedSource(local.centralGatewayUrl, code, digest, timeoutMs)
      } catch (pairError) {
        if (!(pairError instanceof GatewayFailure) || pairError.code !== 'unauthorized') throw pairError
        pairingRejected = true
      }
      try {
        config = await readConfiguration()
      } catch (configError) {
        if (pairingRejected && configError instanceof GatewayFailure && configError.code === 'unauthorized') {
          throw new SyncFailure('center', 'pairing_code_rejected')
        }
        throw configError
      }
    }

    if (registration.sourceInstanceId === null) {
      const paired = { ...registration, sourceInstanceId: config.sourceInstanceId }
      await writeStateJson(directory, registrationFile, paired)
      registration = paired
      diagnostics.update({ credentialConfigured: true })
    } else if (registration.sourceInstanceId !== config.sourceInstanceId) {
      throw new StateError('identity_mismatch')
    }
    const options: RuntimeSyncOptions = {
      sourceGatewayUrl: local.sourceGatewayUrl, centralGatewayUrl: local.centralGatewayUrl,
      requestTimeoutSec: local.requestTimeoutSec, initialMode: 'now', reportingKey: registration.key,
      sourceCallerKeyId: config.sourceCallerKeyId, sourceProviderId: config.sourceProviderId,
      pollIntervalSec: config.pollIntervalSec,
    }
    return { options, enabled: config.enabled, sourceInstanceId: config.sourceInstanceId }
  }
}
