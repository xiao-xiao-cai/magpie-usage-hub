import { Database } from 'bun:sqlite'
import { lstatSync } from 'node:fs'
import type { ReportRow } from '../sync/mapping.ts'
import { checkSourceTable, createSourceTable } from './sources.ts'

const ledgerVersion = 2

export function openCenterLedger(path: string): Database {
  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (existing && !existing.isFile()) throw new Error('center_ledger_unavailable')
  const database = new Database(path, { create: true, strict: true })
  try {
    const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== 1 && version !== ledgerVersion) throw new Error('center_ledger_version_unsupported')
    if (version === 0 && database.query("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()) {
      throw new Error('center_ledger_version_unsupported')
    }
    if (version !== 0) {
      database.query('SELECT rid, source_instance_id, called_at_ms, row_json FROM usage_reports LIMIT 0').all()
    }
    if (version === ledgerVersion) checkSourceTable(database)
    const journal = database.query<{ journal_mode: string }, []>('PRAGMA journal_mode = WAL').get()
    if (journal?.journal_mode !== 'wal') throw new Error('center_ledger_unavailable')
    database.exec('PRAGMA synchronous = FULL')
    if (version !== ledgerVersion) {
      database.transaction(() => {
        if (version === 0) {
          database.exec(`
            CREATE TABLE usage_reports (
              rid TEXT PRIMARY KEY NOT NULL,
              source_instance_id TEXT NOT NULL,
              called_at_ms INTEGER NOT NULL,
              row_json TEXT NOT NULL
            ) STRICT;
            CREATE INDEX usage_reports_called_at ON usage_reports (called_at_ms, rid);
            CREATE INDEX usage_reports_source_called_at ON usage_reports (source_instance_id, called_at_ms, rid);
          `)
        }
        createSourceTable(database)
        database.exec(`PRAGMA user_version = ${ledgerVersion}`)
      }).immediate()
    }
    return database
  } catch (error) {
    database.close(true)
    throw error
  }
}

export function prepareReportWriter(database: Database) {
  const insert = database.query(`
    INSERT INTO usage_reports (rid, source_instance_id, called_at_ms, row_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (rid) DO NOTHING
  `)
  return database.transaction((sourceInstanceId: string, rows: readonly ReportRow[]) => {
    let accepted = 0
    const records = rows.map((row, index) => {
      const saved = insert.run(row.rid, sourceInstanceId, Date.parse(row.t), JSON.stringify(row)).changes === 1
      if (saved) accepted += 1
      return { index, rid: row.rid, status: saved ? 'accepted' : 'skipped' }
    })
    return { accepted, skipped: rows.length - accepted, records }
  }).immediate
}
