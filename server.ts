import { join } from 'node:path'
import { createDiagnostics, startDiagnostics, updateDiagnosticProgress } from './src/diagnostics.ts'
import { OptionsFailure, readConfigRevision, readSyncOptions } from './src/options.ts'
import { readRecoveryRequest, RecoveryRequestError } from './src/recovery.ts'
import { readStoredSyncState, StateError } from './src/state/store.ts'
import { runContinuousSync } from './src/sync/continuous.ts'

export default {
  id: 'magpie-usage-hub',
  server(input: { directory: string }, options: unknown) {
    const saved: Record<string, unknown> = typeof options === 'object' && options !== null && !Array.isArray(options)
      ? Object.fromEntries(Object.entries(options)) : {}
    const revision = readConfigRevision(saved.configRevision)
    const diagnostics = createDiagnostics(revision, typeof saved.centralKeyFile === 'string' && saved.centralKeyFile.trim() !== '')
    startDiagnostics(diagnostics)
    try {
      const config = readSyncOptions(options)
      const directory = join(input.directory, 'magpie-usage-hub')
      if (config === null) {
        diagnostics.update({ phase: 'disabled' })
        void readStoredSyncState(directory).then(state => {
          if (state) updateDiagnosticProgress(diagnostics, state)
        }).catch((error: unknown) => {
          const code = error instanceof StateError ? error.code : 'state_read_failed'
          diagnostics.update({ failure: { stage: 'state', code } })
        })
      } else {
        const request = readRecoveryRequest(saved.recoveryRequest)
        void runContinuousSync(directory, config, diagnostics, request)
      }
    } catch (error) {
      const code = error instanceof OptionsFailure || error instanceof RecoveryRequestError ? error.code : 'invalid_options'
      const failure = { stage: 'options' as const, code }
      diagnostics.update({ phase: 'blocked', failure })
      console.warn('[magpie-usage-hub]', JSON.stringify({ status: 'blocked', ...failure }))
    }
    return {}
  },
}
