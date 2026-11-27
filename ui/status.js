const byId = id => document.getElementById(id)
const navigation = new URLSearchParams(location.hash.slice(1))
const savedRevision = usageHubOptions.revision(navigation.get('revision'))
const phases = new Map([
  ['starting', '正在启动'], ['disabled', '已停用'], ['migration_required', '需要迁移配置'],
  ['waiting_lock', '等待上一宿主交接'], ['retrying', '等待重试'], ['blocked', '已阻塞'], ['ready', '后台已就绪'],
])
const syncPhases = new Map([
  ['backfill', '正在回填历史'], ['sync', '已同步'], ['rebuilding', '重建中'],
  ['recovery_required', '待确认重建'], ['paused', '已暂停'],
])
const failureText = new Map([
  ['invalid_centerGatewayUrl', '请核对配置页的中心本机网关根地址。'],
  ['gateway_not_loopback', '请填写此宿主的回环网关地址。'],
  ['invalid_requestTimeoutSec', '请填写 1 至 120 秒的本机网关请求超时。'],
  ['invalid_ingestHost', '请核对配置页的 OTLP 监听地址。'],
  ['invalid_ingestPort', '请核对 OTLP 接收端口。'],
  ['invalid_receiverEnabled', '请核对中心的 OTLP 接收开关。'],
  ['invalid_timeZone', '请填写有效的 IANA 时区。'],
  ['center_owner_unavailable', '请核对回环网关是否属于当前 Magpie 实例。'],
  ['center_owner_mismatch', '请核对回环网关是否属于当前 Magpie 实例。'],
  ['state_directory_unavailable', '请核对中心的状态卷及写入权限。'],
  ['center_store_unavailable', '请核对中心的状态卷及写入权限。'],
  ['ingest_listener_unavailable', '接收入口暂不可用。请核对监听地址及端口。'],
  ['timeout', '请求超时。请核对中心本机网关。'],
  ['unavailable', '连接暂不可用。请核对中心本机网关。'],
  ['incompatible_response', '中心本机网关响应无法识别。请核对版本和配置。'],
])
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })
let latest = 0
let pending = false

function showStatus(status) {
  const matches = !savedRevision || status.loadedRevision === savedRevision
  const applied = !savedRevision || status.appliedRevision === savedRevision
  byId('dashboard-link').hidden = !status.ready
  byId('status').hidden = !matches
  if (!matches) {
    byId('notice').textContent = '等待宿主读取保存的修订。可刷新，或返回配置页核对设置。'
    return
  }
  byId('runtime-heading').textContent = status.role === 'center' ? '中心服务' : '插件宿主'
  byId('receiver').textContent = ({ off: '已关闭', listening: '监听中', failed: '启动失败' })[status.receiver] ?? '未知'
  byId('phase').textContent = phases.get(status.phase) ?? '状态未知'
  byId('loaded-revision').textContent = usageHubOptions.revision(status.loadedRevision) || '暂无修订号'
  byId('applied-revision').textContent = usageHubOptions.revision(status.appliedRevision) || '暂无采用记录'
  showTime('retry', Boolean(status.retryAt), status.retryAt, '')
  showFailure('failure', status.failure, '服务暂不可用。请刷新或检查插件日志。')
  showCollector(status)
  const phaseNotice = ({
    migration_required: '请返回配置页，核对中心设置并保存。',
    disabled: '请在中心设置启用本机采集与用量看板。',
  })[status.phase]
  byId('notice').textContent = phaseNotice ?? (applied ? '' : '宿主已读取设置，正在等待后台采用。')
}

function showCollector(status) {
  const active = status.role === 'center' && phases.has(status.collectorPhase)
  byId('collector').hidden = !active
  if (!active) return
  const syncPhase = status.syncPhase === 'sync' && status.hasMore ? '追赶中' : syncPhases.get(status.syncPhase)
  byId('collector-phase').textContent = status.collectorPhase === 'ready' ? syncPhase ?? '等待首次采集' : phases.get(status.collectorPhase)
  showTime('last-sync', true, status.lastSyncedAt, '暂无')
  showTime('last-page', true, status.lastPageAt, '暂无')
  showTime('collector-retry', Boolean(status.collectorRetryAt), status.collectorRetryAt, '')
  showFailure('collector-failure', status.collectorFailure, '本机采集暂不可用。请刷新或检查插件日志。')
}

function showFailure(id, failure, fallback) {
  byId(id).hidden = !failure
  byId(id).textContent = failure ? failureText.get(failure.code) ?? fallback : ''
}

function showTime(id, visible, value, empty) {
  byId(`${id}-row`).hidden = !visible
  const time = Date.parse(value)
  byId(id).textContent = Number.isFinite(time) ? dateTime.format(time) : empty
}

async function refresh() {
  const request = ++latest
  pending = true
  byId('notice').textContent = '正在读取后台状态…'
  try {
    const response = await fetch('../api/status', {
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(6_000),
    })
    if (!response.ok) throw new Error()
    const status = await response.json()
    if (status?.schema !== 'magpie-usage-hub/status-v1') throw new Error()
    if (request === latest) showStatus(status)
  } catch {
    if (request === latest) {
      byId('status').hidden = true
      byId('dashboard-link').hidden = true
      byId('notice').textContent = '暂时无法读取后台状态。请刷新，或检查 Magpie 插件日志。'
    }
  } finally {
    if (request === latest) pending = false
  }
}

const back = window.usageHubHost.backSearch()
byId('dashboard-link').href = `../dashboard/${back}`
for (const [id, path] of [['sources-link', '../sources/'], ['settings-link', '../../../settings.html']]) {
  byId(id).href = path + (back ? `?${new URLSearchParams({ back })}` : '')
}
byId('refresh').addEventListener('click', refresh)
void refresh()
setInterval(() => {
  if (!pending && !document.hidden) void refresh()
}, 10_000)
