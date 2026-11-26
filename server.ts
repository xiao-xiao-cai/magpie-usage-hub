import { join } from 'node:path'
import { readCenterOptions, runCenter } from './src/center/runtime.ts'
import { createDiagnostics, startDiagnostics, updateDiagnosticProgress } from './src/diagnostics.ts'
import { isProviderId, OptionsFailure, readConfigRevision, readManagedSourceOptions, readSyncOptions } from './src/options.ts'
import { readRecoveryRequest, RecoveryRequestError } from './src/recovery.ts'
import { readStoredSyncState, StateError } from './src/state/store.ts'
import { runContinuousSync } from './src/sync/continuous.ts'

export default {
  id: 'magpie-usage-hub',
  server(input: { directory: string }, options: unknown) {
    const saved: Record<string, unknown> = typeof options === 'object' && options !== null && !Array.isArray(options)
      ? Object.fromEntries(Object.entries(options)) : {}
    const revision = readConfigRevision(saved.configRevision)
    const credentialPath = saved.role === 'center' ? saved.ingestKeyFile
      : saved.mode === 'managed' ? saved.pairingCodeFile : saved.centralKeyFile
    const diagnostics = createDiagnostics(revision, typeof credentialPath === 'string' && credentialPath.trim() !== '')
    const directory = join(input.directory, 'magpie-usage-hub')
    try {
      if (saved.role === 'center') {
        const center = readCenterOptions(saved)
        if (center) {
          let services: Awaited<ReturnType<typeof runCenter>>
          startDiagnostics(diagnostics,
            async url => services ? services.dashboard(url)
              : Response.json({ error: { code: 'dashboard_unavailable' } }, { status: 503 }),
            request => services?.manage ? services.manage(request)
              : Response.json({ error: { code: 'source_management_unavailable' } }, { status: 503 }),
          )
          void runCenter(directory, center, diagnostics).then(result => { services = result })
        } else {
          diagnostics.update({ phase: 'disabled' })
          startDiagnostics(diagnostics)
        }
        return {}
      }
      if (saved.role !== undefined && saved.role !== 'source') throw new OptionsFailure('invalid_role')
      const config = saved.mode === 'managed' ? readManagedSourceOptions(saved) : readSyncOptions(options)
      if (config === null) {
        diagnostics.update({ phase: 'disabled' })
        const progress = saved.mode === 'managed' ? join(directory, 'managed')
          : isProviderId(saved.sourceProviderId) ? join(directory, 'trial') : directory
        void readStoredSyncState(progress).then(state => {
          if (state) updateDiagnosticProgress(diagnostics, state)
        }).catch((error: unknown) => {
          const code = error instanceof StateError ? error.code : 'state_read_failed'
          diagnostics.update({ failure: { stage: 'state', code } })
        })
      } else {
        const request = 'mode' in config ? undefined : readRecoveryRequest(saved.recoveryRequest)
        void runContinuousSync(directory, config, diagnostics, request)
      }
    } catch (error) {
      const code = error instanceof OptionsFailure || error instanceof RecoveryRequestError ? error.code : 'invalid_options'
      const failure = { stage: 'options' as const, code }
      diagnostics.update({ phase: 'blocked', failure })
      console.warn('[magpie-usage-hub]', JSON.stringify({ status: 'blocked', ...failure }))
    }
    startDiagnostics(diagnostics)
    return {}
  },
}
