import { join } from 'node:path'
import { failure, isRecord } from './src/center/http.ts'
import { runCenter } from './src/center/runtime.ts'
import { createDiagnostics, startDiagnostics } from './src/diagnostics.ts'
import { OptionsFailure, readConfigRevision, readOptions } from './src/options.ts'
import { runSender } from './src/sync/sender.ts'

export default {
  id: 'magpie-usage-hub',
  server(input: { directory: string }, options: unknown) {
    const saved = isRecord(options) ? options : {}
    const role = saved.collectionMode === 'push' && (saved.role === 'center' || saved.role === 'sender') ? saved.role : null
    const diagnostics = createDiagnostics(readConfigRevision(saved.configRevision), role)
    try {
      if (options !== null && options !== undefined && !isRecord(options)) throw new OptionsFailure('invalid_options')
      const settings = readOptions(saved)
      const stateDirectory = join(input.directory, 'magpie-usage-hub')
      if (settings?.role === 'center') {
        let services: Awaited<ReturnType<typeof runCenter>>
        startDiagnostics(diagnostics,
          async (url, signal) => services?.dashboard(url, signal) ?? failure(503, 'dashboard_unavailable'),
          request => services?.manage(request) ?? failure(503, 'source_management_unavailable'),
        )
        void runCenter(stateDirectory, settings, diagnostics).then(result => { services = result })
        return {}
      }
      if (settings?.role === 'sender') {
        startDiagnostics(diagnostics)
        void runSender(stateDirectory, settings, diagnostics)
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
