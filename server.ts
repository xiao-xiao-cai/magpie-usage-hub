import { OptionsFailure, readSyncOptions } from './src/options.ts'
import { runContinuousSync } from './src/sync/continuous.ts'

export default {
  id: 'magpie-usage-hub',
  server(input: { directory: string }, options: unknown) {
    try {
      const config = readSyncOptions(options)
      if (config !== null) {
        void runContinuousSync(input.directory, config).catch(() => {
          console.warn('[magpie-usage-hub]', '{"status":"blocked","stage":"run","code":"unexpected_failure"}')
        })
      }
    } catch (error) {
      const code = error instanceof OptionsFailure ? error.code : 'invalid_options'
      console.warn('[magpie-usage-hub]', JSON.stringify({ status: 'blocked', stage: 'options', code }))
    }
    return {}
  },
}
