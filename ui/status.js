const byId = id => document.getElementById(id)
const navigation = new URLSearchParams(location.hash.slice(1))
const savedRevision = navigation.get('revision')
const openDashboard = navigation.get('view') === 'dashboard'
const phases = new Map([
  ['starting', '正在启动'], ['disabled', '已停用'], ['migration_required', '需要迁移配置'],
  ['waiting_lock', '等待上一宿主交接'], ['retrying', '等待重试'], ['blocked', '已阻塞'], ['ready', '后台已就绪'],
])
const syncPhases = new Map([
  ['backfill', '正在回填历史'], ['sync', '同步中'], ['rebuilding', '正在重建'],
  ['recovery_required', '等待中心处理游标故障'], ['paused', '中心已暂停此来源'],
])
const failureText = new Map([
  ['invalid_centerGatewayUrl', '请核对配置页的中心本机网关根地址。'],
  ['invalid_sourceGatewayUrl', '请核对配置页的来源本机网关根地址。'],
  ['invalid_centerIngestUrl', '请核对中心接收根地址。'],
  ['gateway_not_loopback', '请填写此宿主的回环网关地址。'],
  ['invalid_requestTimeoutSec', '请填写 1 至 120 秒的请求超时。'],
  ['invalid_ingestHost', '请核对配置页的接收监听地址。'],
  ['invalid_ingestPort', '请核对接收端口是否有效且未被占用。'],
  ['invalid_timeZone', '请填写有效的 IANA 时区。'],
  ['invalid_sourceId', '请填写中心登记的来源 ID。'],
  ['invalid_reportKeyFile', '请填写令牌文件绝对路径。'],
  ['center_owner_unavailable', '请核对回环网关是否属于当前 Magpie 实例。'],
  ['center_owner_mismatch', '请核对回环网关是否属于当前 Magpie 实例。'],
  ['center_store_unavailable', '请核对中心的状态卷及写入权限。'],
  ['ingest_listener_unavailable', '接收入口暂不可用。请核对监听地址及端口。'],
  ['report_key_file_unavailable', '无法读取令牌文件。请核对文件路径及宿主账号权限。'],
  ['report_key_file_invalid', '请核对令牌文件格式及权限。'],
  ['source_binding_mismatch', '已配置的来源与保存的绑定不一致。请核实中心及来源 ID。'],
  ['state_invalid', '无法采用已保存的来源绑定。请核对配置目录、网关地址、中心地址和来源 ID。'],
  ['state_write_failed', '无法保存来源绑定。请核对插件状态目录权限。'],
  ['report_key_invalid', '中心未接受上报凭据。请核对令牌文件与中心登记的摘要。'],
  ['source_mismatch', '上报凭据与来源 ID 不匹配。请核对中心来源登记。'],
  ['source_paused', '中心已暂停此来源。恢复后将继续上报。'],
  ['source_recovery_required', '请在中心来源管理核对原生游标故障并确认同源重建。'],
  ['timeout', '请求超时。请核对本机网关或中心接收链路。'],
  ['unavailable', '连接暂不可用。请核对本机网关或中心接收链路。'],
  ['redirect', '中心地址返回重定向。请填写实际接收根地址。'],
  ['incompatible_response', '响应无法识别。请核对两端版本和配置。'],
  ['invalid_center_response', '中心响应无法识别。请核对接收地址和中心插件版本。'],
])
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })
let latest = 0
let pending = false

function showStatus(status) {
  const matches = !savedRevision || status.loadedRevision === savedRevision
  const applied = !savedRevision || status.appliedRevision === savedRevision
  const showDashboard = matches && applied && status.ready && status.role === 'center'
  byId('dashboard-link').hidden = !showDashboard
  byId('status').hidden = !matches
  if (!matches) {
    byId('notice').textContent = '等待宿主读取保存的修订。可刷新，或返回配置页核对设置。'
    return
  }
  if (openDashboard && showDashboard) {
    location.replace('dashboard/')
    return
  }
  byId('runtime-heading').textContent = status.role === 'center' ? '中心接收服务'
    : status.role === 'sender' ? '来源同步任务' : '插件宿主'
  byId('phase').textContent = phases.get(status.phase) ?? '状态未知'
  byId('loaded-revision').textContent = status.loadedRevision ?? '暂无修订号'
  byId('applied-revision').textContent = status.appliedRevision ?? '暂无采用记录'
  const sender = status.role === 'sender'
  byId('sync-row').hidden = !sender
  byId('sync-phase').textContent = status.syncPhase === 'sync' && !status.hasMore ? '已追上源端'
    : syncPhases.get(status.syncPhase) ?? '等待中心认证'
  showTime('last-page', sender, status.lastPageAt, '暂无回执')
  showTime('last-sync', sender, status.lastSyncedAt, '尚未完成')
  showTime('retry', Boolean(status.retryAt), status.retryAt, '')
  const failure = byId('failure')
  failure.hidden = !status.failure
  failure.textContent = status.failure ? failureText.get(status.failure.code) ?? '服务暂不可用。请刷新或检查插件日志。' : ''
  const phaseNotice = ({
    migration_required: '请返回配置页，为此实例选择新版角色并保存。',
    disabled: '请返回配置页，启用并保存所选角色。',
  })[status.phase]
  byId('notice').textContent = phaseNotice ?? (applied ? '' : '宿主已读取设置，正在等待后台采用。')
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
      byId('dashboard-link').hidden = true
      byId('notice').textContent = '暂时无法读取后台状态。请刷新，或检查 Magpie 插件日志。'
    }
  } finally {
    if (request === latest) pending = false
  }
}

byId('refresh').addEventListener('click', refresh)
void refresh()
setInterval(() => {
  if (!pending && !document.hidden) void refresh()
}, openDashboard ? 1_500 : 10_000)
