import { Database, SQLiteError } from 'bun:sqlite'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { StateError } from './errors.ts'

export type SyncLock = { release(): void }

function closeLock(database: Database): void {
  try {
    database.close(true)
  } catch {
    throw new StateError('lock_unavailable')
  }
}

export function tryAcquireSyncLock(directory: string): SyncLock | undefined {
  const path = join(directory, 'sync.lock.sqlite')
  let database: Database | undefined
  try {
    const existing = lstatSync(path, { throwIfNoEntry: false })
    if (existing && !existing.isFile()) throw new StateError('lock_unavailable')
    database = new Database(path, { create: true })
    database.run('PRAGMA busy_timeout = 0')
    database.run('BEGIN IMMEDIATE')
  } catch (error) {
    if (database) closeLock(database)
    if (error instanceof SQLiteError && error.code === 'SQLITE_BUSY') return undefined
    throw new StateError('lock_unavailable')
  }

  let active = true
  return {
    release() {
      if (!active) return
      active = false
      try {
        database.run('ROLLBACK')
      } catch {
        throw new StateError('lock_unavailable')
      } finally {
        closeLock(database)
      }
    },
  }
}
