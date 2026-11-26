const byId = id => document.getElementById(id)
const displayTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })
const savedRevision = new URLSearchParams(location.hash.slice(1)).get('revision')
const phases = new Map([
  ['starting', '正在启动'], ['disabled', '配置已停用'], ['waiting_lock', '等待上一宿主交接'],
  ['syncing', '正在同步'], ['recovering', '正在回填'], ['idle', '等待下次轮询'],
  ['retrying', '退避重试'], ['blocked', '已阻塞'],
])
const failureText = new Map([
  ['unauthorized', '请核对网关权限和专用上报 Key。'],
  ['binding_mismatch', '请恢复与持久进度一致的来源、采集条件、原中心和首次起点。'],
  ['cursor_reset', '源游标已重置，请在配置页提交游标恢复。'],
  ['cursor_expired', '源游标已过期，请在配置页提交游标恢复。'],
  ['key_file_unreadable', '请核对上报凭据文件路径和宿主账户的读取权限。'],
  ['recovery_binding_mismatch', '请求的配置绑定与当前来源进度不同。'],
  ['recovery_no_checkpoint', '需要已有的日常同步进度。首次使用时请撤回请求并等待初始进度就绪。'],
  ['recovery_busy', '已有回填任务，请在该任务结束后重新确认范围。'],
  ['recovery_cursor_valid', '原游标仍有效。补回中心缺口时请选择指定时间段。'],
  ['recovery_cursor_incompatible', '请核对来源和采集条件，确认原游标的错误类别。'],
  ['recovery_scan_cursor_expired', '回填扫描游标已过期。请核对可见历史并重新确认回填范围。'],
  ['recovery_scan_cursor_reset', '回填扫描游标已重置。请核对可见历史并重新确认回填范围。'],
])
const stages = new Map([
  ['source', '来源'], ['center', '中心'], ['state', '进度'], ['mapping', '用量数据'], ['options', '设置'], ['run', '后台任务'],
])
let latest = 0
let pending = false

function text(id, value) {
  byId(id).textContent = value
}

function time(value, empty = '暂无') {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? displayTime.format(timestamp) : empty
}

function counts({ accepted, skipped }) {
  return `确认 ${accepted + skipped} 条（含去重 ${skipped} 条）`
}

function showFailure(id, code, httpStatus, stage) {
  byId(id).hidden = !code
  const suggestion = failureText.get(code) ?? ''
  const prefix = stages.has(stage) ? `${stages.get(stage)} · ` : ''
  text(id, code ? `${prefix}${code}${httpStatus ? ` · HTTP ${httpStatus}` : ''}${suggestion ? `。${suggestion}` : ''}` : '')
}

function showStatus(status) {
  if (!savedRevision || status.loadedRevision !== savedRevision) {
    byId('status').hidden = true
    text('notice', '等待读取与配置页保存修订一致的后台状态。可返回配置重新打开诊断，或检查宿主日志。')
    return
  }
  byId('status').hidden = false
  text('phase', phases.get(status.phase) ?? '状态未知')
  text('credential', status.credentialConfigured ? '已配置' : '待配置')
  text('loaded-revision', status.loadedRevision ?? '暂无修订号')
  text('applied-revision', status.appliedRevision ?? '暂无采用记录')
  text('last-attempt', time(status.lastAttemptAt))
  text('last-confirmed', time(status.lastConfirmedAt))
  text('retry', time(status.retryAt, '当前无退避'))
  showFailure('failure', status.failure?.code, status.failure?.httpStatus, status.failure?.stage)

  const page = status.lastPage
  text('last-page', page
    ? `${page.kind === 'recovery' ? '回填' : '日常同步'} · ${counts(page)} · ${page.hasMore ? '源流还有后续页' : '已读到本次页尾'}`
    : '本次宿主暂无整页确认。')

  const recovery = status.recovery
  byId('no-recovery').hidden = Boolean(recovery)
  byId('recovery').hidden = !recovery
  if (recovery) {
    let phase = '已拒绝'
    if (recovery.status === 'complete') phase = '已完成'
    if (recovery.status === 'failed') phase = '已中止'
    if (recovery.status === 'running') {
      phase = ({ disabled: '已暂停', blocked: '已阻塞', retrying: '等待重试' })[status.phase] ?? '已受理'
    }
    text('recovery-phase', phase)
    text('recovery-kind', recovery.kind === 'range' ? '指定时间段' : '游标恢复')
    text('recovery-from', time(recovery.from))
    text('recovery-to', time(recovery.to, '源流当前进度'))
    text('recovery-count', `${recovery.pages} 页 · ${counts(recovery)}`)
  }
  showFailure('recovery-failure', recovery?.failure)

  let message = '宿主已读取保存的修订，等待同步任务采用。'
  if (savedRevision === status.appliedRevision) message = '后台已采用从配置页打开时的修订。'
  else if (status.phase === 'disabled') message = '宿主已读取保存的停用设置。'
  text('notice', message)
}

async function refresh() {
  const request = ++latest
  pending = true
  text('notice', '正在读取后台状态…')
  try {
    const response = await fetch('api/status', {
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(6_000),
    })
    if (!response.ok) throw new Error()
    const status = await response.json()
    if (status?.schema !== 'magpie-usage-hub/status-v1') throw new Error()
    if (request === latest) showStatus(status)
  } catch {
    if (request === latest) {
      byId('status').hidden = true
      text('notice', '暂时无法读取后台状态。请刷新，或检查 Magpie 插件日志中的诊断服务提示。')
    }
  } finally {
    if (request === latest) pending = false
  }
}

byId('refresh').addEventListener('click', refresh)
refresh()
setInterval(() => {
  if (!pending && !document.hidden) refresh()
}, 10_000)
