import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord } from '../center/http.ts'
import { StateError } from './errors.ts'

const windowsRenameRetryDelaysMs = [10, 25, 50, 100] as const

export async function readStateJson(directory: string, name: 'sources.json'): Promise<unknown> {
  const path = join(directory, name)
  try {
    const file = await lstat(path)
    if (!file.isFile() || (process.platform !== 'win32' && (file.mode & 0o077) !== 0)) {
      throw new StateError('state_invalid')
    }
  } catch (error) {
    if (error instanceof StateError) throw error
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw new StateError('state_read_failed')
  }
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return value
  } catch {
    throw new StateError('state_invalid')
  }
}

export async function writeStateJson(directory: string, name: 'sources.json', value: object): Promise<void> {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`)
  let created = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    created = true
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    const target = join(directory, name)
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, target)
        break
      } catch (error) {
        const delayMs = windowsRenameRetryDelaysMs[attempt]
        const code = isRecord(error) ? error.code : undefined
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
