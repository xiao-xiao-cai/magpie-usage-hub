import { join } from 'node:path'
import { isRecord } from './src/center/http.ts'
import { runCenter } from './src/center/runtime.ts'
import { createDiagnostics, startDiagnostics } from './src/diagnostics.ts'
import { isFreshInstallation, OptionsFailure, readConfigRevision, readOptions } from './src/options.ts'

export default {
  id: 'magpie-usage-hub',
  server(input: { directory: string }, options: unknown) {
    const saved = isRecord(options) ? options : {}
    const role = isFreshInstallation(saved) || (saved.role === 'center'
      && (saved.collectionMode === 'otlp' || saved.collectionMode === 'push')) ? 'center' : null
    const diagnostics = createDiagnostics(readConfigRevision(saved.configRevision), role)
    try {
      if (options !== null && options !== undefined && !isRecord(options)) throw new OptionsFailure('invalid_options')
      const settings = readOptions(saved, process.env.MAGPIE_ADDR)
      if (settings) {
        const stateDirectory = join(input.directory, 'magpie-usage-hub')
        void runCenter(stateDirectory, settings, diagnostics).then(services => {
          if (diagnostics.getStatus().failure?.code === 'center_owner_mismatch') return
          startDiagnostics(diagnostics, services?.dashboard, services?.manage, input.directory)
        })
        return {}
      }
      diagnostics.update({ phase: saved.enabled === true ? 'migration_required' : 'disabled' })
    } catch (error) {
      const code = error instanceof OptionsFailure ? error.code : 'invalid_options'
      const problem = { stage: 'options' as const, code }
      diagnostics.update({ phase: 'blocked', failure: problem })
      console.warn('[magpie-usage-hub]', JSON.stringify({ status: 'blocked', ...problem }))
    }
    startDiagnostics(diagnostics)
    return {}
  },
}
