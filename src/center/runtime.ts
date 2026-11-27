import { join } from 'node:path'
import type { Diagnostics } from '../diagnostics.ts'
import { acquireGatewayLock, logRuntime, reportBlocked } from '../host.ts'
import type { readCenterOptions } from '../options.ts'
import { createDashboard } from './dashboard.ts'
import { openPullSources } from './sources.ts'

type CenterOptions = NonNullable<ReturnType<typeof readCenterOptions>>

export async function runCenter(stateDirectory: string, options: CenterOptions, diagnostics: Diagnostics) {
  let owner: Awaited<ReturnType<typeof acquireGatewayLock>>
  try {
    owner = await acquireGatewayLock(stateDirectory, options.gateway, options.timeoutMs, diagnostics)
  } catch (error) {
    reportBlocked(error, diagnostics, 'center_owner_unavailable')
    return
  }

  try {
    const sources = await openPullSources(join(owner.directory, 'pull'), options.timeoutMs)
    process.once('exit', () => {
      try { owner.lock.release() } catch {}
    })
    diagnostics.update({ phase: 'ready', appliedRevision: diagnostics.getStatus().loadedRevision,
      ready: true, failure: null, retryAt: null,
    })
    logRuntime({ status: 'center_ready' })
    return {
      dashboard: createDashboard(options.gateway, options.timeoutMs, sources.getSources),
      manage: sources.manage,
    }
  } catch (error) {
    try { owner.lock.release() } catch {}
    reportBlocked(error, diagnostics, 'pull_sources_unavailable')
  }
}
