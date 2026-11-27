const byId = id => document.getElementById(id)
const period = byId('period')
const results = byId('results')
const notice = byId('notice')
const numbers = new Intl.NumberFormat('zh-CN')
const dollars = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 10 })
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })
const failures = new Map([
  ['unauthorized', 'Key 无效'], ['forbidden', '访问被拒绝'], ['timeout', '连接超时'],
  ['unavailable', '网关不可达或服务异常'], ['incompatible_response', '网关响应不兼容'],
  ['redirect', '网关返回重定向'], ['restricted_key', 'Key 的用量范围受限'],
])
let sequence = 0
let activeRequest
let shownPeriod

function cell(row, value, className = '', heading = false) {
  const element = document.createElement(heading ? 'th' : 'td')
  if (heading) element.scope = 'row'
  element.className = className
  element.textContent = value
  row.append(element)
  return element
}

function pair(left, right) {
  return `${numbers.format(left)} / ${numbers.format(right)}`
}

function cost(value) {
  return value > 0 && value < 0.0000000001 ? '<0.0000000001' : dollars.format(value)
}

function appendTime(container, timestamp, label) {
  const time = document.createElement('time')
  time.dateTime = timestamp
  time.textContent = label
  container.append(time)
}

function summaryRow(source) {
  const { name, status, since, checkedAt, totals, failure } = source
  const row = document.createElement('tr')
  cell(row, name, 'source-name', true)
  const window = cell(row, since ? '' : status === 'ok' ? '起点未提供' : '—', 'usage-since')
  if (since) appendTime(window, since, since.replace('T', ' ').replace(/(Z|[+-]\d{2}:\d{2})$/, ' $1').replace(/Z$/, 'UTC'))
  const values = status === 'ok' ? [
    numbers.format(totals.calls), pair(totals.input, totals.output), pair(totals.cacheRead, totals.cacheWrite),
    cost(totals.cost), numbers.format(totals.unpriced),
  ] : ['—', '—', '—', '—', '—']
  for (const value of values) cell(row, value, status === 'ok' ? '' : 'muted')
  const currentState = status === 'ok' ? '成功' : status === 'paused' ? '已停用'
    : `暂不可用 · ${failures.get(failure?.code) ?? '读取失败'}`
  const state = cell(row, currentState, 'usage-state')
  if (checkedAt) appendTime(state, checkedAt, dateTime.format(Date.parse(checkedAt)))
  return row
}

async function refresh() {
  const request = ++sequence
  activeRequest?.abort()
  const controller = new AbortController()
  activeRequest = controller
  const selected = period.value
  const samePeriod = shownPeriod === selected
  results.hidden = !samePeriod
  results.setAttribute('aria-busy', 'true')
  notice.textContent = '正在读取用量…'
  try {
    const response = await fetch(`../api/usage?${new URLSearchParams({ period: selected })}`, {
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
    })
    if (!response.ok) throw new Error()
    const usage = await response.json()
    if (request !== sequence) return
    if (usage?.schema !== 'magpie-usage-hub/usage-v2' || usage.period !== selected || !Array.isArray(usage.sources)) {
      throw new Error()
    }
    byId('summary-rows').replaceChildren(...usage.sources.map(summaryRow))
    shownPeriod = selected
    results.hidden = false
    const unavailable = usage.sources.filter(source => source.status === 'unavailable').length
    notice.textContent = unavailable ? `${unavailable} 个来源暂不可用。刷新后可重试。` : ''
  } catch {
    if (request === sequence) {
      notice.textContent = samePeriod ? '本次读取失败。当前显示上次结果，可刷新重试。'
        : '暂时无法读取用量。可刷新重试，或打开后台诊断。'
    }
  } finally {
    if (request === sequence) {
      results.setAttribute('aria-busy', 'false')
      activeRequest = undefined
    }
  }
}

byId('refresh').addEventListener('click', refresh)
period.addEventListener('change', refresh)
void refresh()
