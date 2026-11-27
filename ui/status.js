const byId = id => document.getElementById(id)
const navigation = new URLSearchParams(location.hash.slice(1))
const savedRevision = navigation.get('revision')
const openDashboard = navigation.get('view') === 'dashboard'
const phases = new Map([
  ['starting', '正在启动'], ['disabled', '已停用'], ['migration_required', '需要迁移配置'],
  ['waiting_lock', '等待上一宿主交接'], ['retrying', '等待重试'], ['blocked', '已阻塞'], ['ready', '查询服务已就绪'],
])
const failureText = new Map([
  ['invalid_centerGatewayUrl', '请核对配置页的中心本机网关根地址。'],
  ['center_not_loopback', '请填写中心宿主的回环网关地址。'],
  ['invalid_requestTimeoutSec', '请填写 1 至 120 秒的请求超时。'],
  ['center_owner_unavailable', '请核对配置的网关是否属于当前中心 Magpie 实例。'],
  ['center_owner_mismatch', '请核对配置的网关是否属于当前中心 Magpie 实例。'],
  ['pull_sources_unavailable', '请核对宿主的来源配置目录及访问权限。'],
  ['state_invalid', '来源配置无法识别。请核对已保存的配置及备份。'],
  ['state_read_failed', '暂时无法读取来源配置。请核对文件及访问权限。'],
])
let latest = 0
let pending = false

function showStatus(status) {
  const matches = !savedRevision || status.loadedRevision === savedRevision
  byId('dashboard-link').hidden = !matches || !status.ready
  byId('status').hidden = !matches
  if (!matches) {
    byId('notice').textContent = '等待宿主读取保存的修订。可刷新，或返回配置页核对设置。'
    return
  }
  if (openDashboard && status.ready) {
    location.replace('dashboard/')
    return
  }
  byId('phase').textContent = phases.get(status.phase) ?? '状态未知'
  byId('loaded-revision').textContent = status.loadedRevision ?? '暂无修订号'
  byId('applied-revision').textContent = status.appliedRevision ?? '暂无采用记录'
  const failure = byId('failure')
  failure.hidden = !status.failure
  failure.textContent = status.failure ? failureText.get(status.failure.code) ?? '服务暂不可用。请刷新或检查插件日志。' : ''
  const phaseNotice = ({
    migration_required: '请返回配置页，启用并保存中心只读查询，再从用量看板登记来源。',
    disabled: '请返回配置页，启用并保存中心只读查询。',
  })[status.phase]
  byId('notice').textContent = phaseNotice ?? ''
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
