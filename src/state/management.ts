import { createHmac, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function readManagementToken(hostDirectory: string, hostPid = process.ppid): Promise<string> {
  const directory = join(hostDirectory, 'magpie-usage-hub', 'management')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const state = await lstat(directory)
  if (!state.isDirectory() || (process.platform !== 'win32' && (state.mode & 0o077) !== 0)) throw new Error('management_state_unprotected')

  const path = join(directory, 'key')
  if (!(await lstat(path, { throwIfNoEntry: false }))) {
    const temporary = join(directory, `key-${randomBytes(16).toString('hex')}`)
    await writeFile(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 })
    try {
      await link(temporary, path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    } finally {
      await unlink(temporary)
    }
  }
  const file = await lstat(path)
  if (!file.isFile() || file.size !== 32 || (process.platform !== 'win32' && (file.mode & 0o077) !== 0)) throw new Error('management_key_unprotected')
  return createHmac('sha256', await readFile(path)).update(`usage-hub-management:${hostPid}`).digest('hex')
}
