import { OptionsFailure, readTestOptions } from './src/options.ts'
import { runTestOnce } from './src/test-run.ts'

export default {
  id: 'magpie-usage-hub',
  server(input: { directory: string }, options: unknown) {
    try {
      const test = readTestOptions(options)
      if (test !== null) {
        void runTestOnce(input.directory, test).then((result) => {
          if (result !== null) console.info('[magpie-usage-hub]', JSON.stringify(result))
        }).catch(() => console.warn('[magpie-usage-hub] unexpected_failure'))
      }
    } catch (error) {
      const code = error instanceof OptionsFailure ? error.code : 'invalid_options'
      console.warn('[magpie-usage-hub]', code)
    }
    return {}
  },
}
