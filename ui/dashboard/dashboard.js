const byId = id => document.getElementById(id)
const period = byId('period')
const results = byId('results')
const notice = byId('notice')
const queryToken = document.querySelector('meta[name="usage-query-token"]')?.content
const numbers = new Intl.NumberFormat('zh-CN')
const dollars = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 10 })
const freshnessText = new Map([
  ['new', '等待首次同步'], ['current', '已同步'], ['catching_up', '追赶中'], ['offline', '暂失联'], ['stalled', '等待新回执'],
  ['paused', '已暂停'], ['rebuilding', '重建中'], ['recovery_required', '待确认重建'],
])
const explicitTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const sourceNames = new Map()
let sequence = 0
let activeRequest
let rowsRequest
let shownQuery
let shownRange
let pageState
let dateTime

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

function formatTime(value) {
  return dateTime.format(Date.parse(value))
}

function appendTime(container, timestamp) {
  const time = document.createElement('time')
  time.dateTime = timestamp
  time.title = timestamp
  time.textContent = formatTime(timestamp)
  container.append(time)
}

function appendNote(container, text) {
  const element = document.createElement('span')
  element.className = 'detail-meta'
  element.textContent = text
  container.append(element)
}

function appendTotals(row, totals) {
  const values = totals ? [numbers.format(totals.calls), pair(totals.input, totals.output),
    pair(totals.cacheRead, totals.cacheWrite), cost(totals.cost), numbers.format(totals.unpriced)]
    : ['—', '—', '—', '—', '—']
  for (const value of values) cell(row, value)
}

function summaryRow(source) {
  const row = document.createElement('tr')
  cell(row, source.name, 'source-name', true)
  const status = cell(row, freshnessText.get(source.freshness) ?? '等待同步', 'usage-state')
  if (source.lastSyncedAt) appendNote(status, `最近完成 ${formatTime(source.lastSyncedAt)}`)
  const coverage = cell(row, source.coverage ? '' : '暂无已同步调用', 'usage-coverage')
  if (source.coverage) {
    appendTime(coverage, source.coverage.from)
    if (source.coverage.from !== source.coverage.to) appendNote(coverage, `至 ${formatTime(source.coverage.to)}`)
  }
  if (source.gap) {
    const { missingRows, from, to } = source.gap
    appendNote(coverage, from && to ? `上次重建未找到 ${numbers.format(missingRows)} 条旧记录`
      : '重建前的历史可能有缺口')
    if (from && to) appendNote(coverage, `${formatTime(from)} 至 ${formatTime(to)}`)
  }
  appendTotals(row, source.hasPublishedData ? source.totals : null)
  return row
}

function modelRow(source, item) {
  const row = document.createElement('tr')
  cell(row, item.model || '未标注模型', 'model-name', true)
  cell(row, source.name, 'source-name')
  appendTotals(row, item.totals)
  return row
}

function trendGroup(source, expanded) {
  const group = document.createElement('details')
  group.className = 'trend-group'
  const heading = document.createElement('summary')
  heading.textContent = source.name
  group.append(heading)

  function render() {
    const region = document.createElement('div')
    region.className = 'table-scroll'
    region.tabIndex = 0
    region.setAttribute('role', 'region')
    region.setAttribute('aria-label', `${source.name} 的请求趋势`)
    const table = document.createElement('table')
    const head = document.createElement('thead')
    const titles = document.createElement('tr')
    for (const title of ['统计时段', '请求数', '输入 / 输出 Token', '已计价估算费用（USD）']) {
      const headingCell = document.createElement('th')
      headingCell.scope = 'col'
      headingCell.textContent = title
      titles.append(headingCell)
    }
    head.append(titles)
    table.append(head)
    const body = document.createElement('tbody')
    const maximum = Math.max(1, ...source.buckets.map(bucket => bucket.totals.calls))
    for (const bucket of source.buckets) {
      const row = document.createElement('tr')
      const time = cell(row, '', '', true)
      appendTime(time, bucket.from)
      appendNote(time, `至 ${formatTime(bucket.to)}`)
      const calls = cell(row, numbers.format(bucket.totals.calls))
      const meter = document.createElement('meter')
      meter.max = maximum
      meter.value = bucket.totals.calls
      meter.setAttribute('aria-hidden', 'true')
      calls.append(meter)
      cell(row, pair(bucket.totals.input, bucket.totals.output))
      cell(row, cost(bucket.totals.cost))
      body.append(row)
    }
    table.append(body)
    region.append(table)
    group.append(region)
  }

  if (expanded) {
    group.open = true
    render()
  } else group.addEventListener('toggle', () => { if (group.open) render() }, { once: true })
  return group
}

function detailRow(item) {
  const row = document.createElement('tr')
  appendTime(cell(row, '', '', true), item.t)
  cell(row, sourceNames.get(item.sourceId) ?? '来源', 'source-name')
  cell(row, item.model || '未标注模型', 'model-name')
  const via = cell(row, item.via === 'through' ? '经网关' : '直连')
  if (item.handedOn) appendNote(via, '中间尝试')
  cell(row, pair(item.input, item.output))
  const cache = cell(row, pair(item.cacheRead, item.cacheWrite))
  if (item.cacheUnknown) appendNote(cache, '缓存计数未知')
  cell(row, numbers.format(item.reasoning))
  cell(row, item.cost === null ? (item.input || item.output ? '缺价' : '—') : cost(item.cost))
  cell(row, item.status == null ? '—' : String(item.status))
  cell(row, item.durationMs == null ? '—' : numbers.format(item.durationMs))
  return row
}

function sourceOptions(sources, selectedSource) {
  for (const source of sources) sourceNames.set(source.id, source.name)
  if (selectedSource) return
  const select = byId('source')
  const draft = select.value
  select.replaceChildren(newOption('', '全部来源'), ...sources.map(source => newOption(source.id, source.name)))
  select.value = sources.some(source => source.id === draft) ? draft : ''
}

function newOption(value, label = value) {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  return option
}

function readFilters() {
  const filters = new URLSearchParams()
  for (const name of ['via', 'bucket']) {
    const value = byId(name).value
    if (value) filters.set(name, value)
  }
  const model = byId('model').value
  if (model.startsWith('model:')) filters.set('model', model.slice(6))
  if (byId('source').value) filters.set('sourceId', byId('source').value)
  if (period.value !== 'custom') {
    filters.set('period', period.value)
    return filters
  }
  const from = byId('from').value.trim()
  const to = byId('to').value.trim()
  if (!explicitTime.test(from) || !explicitTime.test(to) || !(Date.parse(from) < Date.parse(to))) {
    notice.textContent = '请填写含时区的有效起止时间，且结束晚于开始。'
    return undefined
  }
  filters.set('from', from)
  filters.set('to', to)
  return filters
}

async function query(path, params, signal) {
  if (!/^[0-9a-f]{64}$/.test(queryToken ?? '')) throw new Error('query_token_invalid')
  const response = await fetch(`../api/${path}?${params}`, {
    headers: { 'X-Magpie-Usage-Query': queryToken }, cache: 'no-store', credentials: 'omit', redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  if (response.status === 403) throw new Error('query_token_invalid')
  if (!response.ok) {
    const problem = await response.json().catch(() => null)
    const code = problem?.error?.code
    throw new Error(code === 'bucket_range_too_large' || code === 'invalid_page' ? code : 'query_failed')
  }
  return response.json()
}

function showSummary(usage, filters) {
  const { range, sources } = usage
  dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: range.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
  })
  byId('range-label').textContent = `${formatTime(range.from)} 至 ${formatTime(range.to)}（${range.timeZone}，结束时间不含）`
  sourceOptions(sources, filters.get('sourceId'))
  byId('summary-rows').replaceChildren(...sources.map(summaryRow))
  const models = sources.flatMap(source => source.models.map(item => modelRow(source, item)))
  byId('model-rows').replaceChildren(...models)
  byId('models-empty').hidden = models.length > 0
  byId('models-table').hidden = models.length === 0
  if (!filters.has('model')) {
    const modelNames = [...new Set(sources.flatMap(source => source.models.map(item => item.model)))].sort()
    const select = byId('model')
    const draft = select.value
    select.replaceChildren(newOption('', '全部模型'), ...modelNames.map(name => newOption(`model:${name}`, name || '未标注模型')))
    select.value = modelNames.some(name => `model:${name}` === draft) ? draft : ''
  }
  const trends = sources.filter(source => source.hasPublishedData && source.buckets.length)
  byId('trends').replaceChildren(...trends.map((source, index) => trendGroup(source, index === 0)))
  byId('trend').hidden = trends.length === 0
  shownRange = range
  results.hidden = false
}

function rowsControls() {
  byId('row-pages').hidden = !pageState?.loaded
  byId('previous-rows').disabled = Boolean(activeRequest || rowsRequest || !pageState?.index)
  byId('next-rows').disabled = Boolean(activeRequest || rowsRequest || !pageState?.next)
  byId('rows-section').setAttribute('aria-busy', String(Boolean(rowsRequest)))
}

async function loadRows(index) {
  const state = pageState
  if (!state || rowsRequest || activeRequest) return
  const controller = new AbortController()
  rowsRequest = controller
  rowsControls()
  byId('rows-notice').textContent = '正在读取明细…'
  const params = new URLSearchParams(state.filters)
  if (state.tokens[index]) params.set('page', state.tokens[index])
  try {
    const details = await query('usage/rows', params, controller.signal)
    if (controller !== rowsRequest) return
    byId('detail-rows').replaceChildren(...details.rows.map(detailRow))
    byId('rows-table').hidden = details.rows.length === 0
    byId('rows-notice').textContent = details.rows.length ? '' : '该查询没有匹配的请求明细。'
    byId('current-page').textContent = `第 ${numbers.format(index + 1)} 页`
    state.index = index
    state.next = details.nextPage
    state.tokens[index + 1] = details.nextPage
    state.loaded = details.rows.length > 0 || index > 0
  } catch (error) {
    if (controller === rowsRequest) {
      const failures = {
        query_token_invalid: '查询会话已失效。请从后台诊断重新打开看板。',
        invalid_page: '来源数据已更新。请重新查询，从第一页读取明细。',
      }
      byId('rows-notice').textContent = failures[error.message] ?? '明细读取失败。可重新查询。'
    }
  } finally {
    if (controller === rowsRequest) {
      rowsRequest = undefined
      rowsControls()
    }
  }
}

async function refresh() {
  const filters = readFilters()
  if (!filters) return
  const id = ++sequence
  activeRequest?.abort()
  rowsRequest?.abort()
  rowsRequest = undefined
  const controller = new AbortController()
  activeRequest = controller
  rowsControls()
  const fingerprint = filters.toString()
  const sameQuery = shownQuery === fingerprint
  results.hidden = !sameQuery
  results.setAttribute('aria-busy', 'true')
  notice.textContent = '正在读取用量…'
  let nextState
  try {
    let usage
    let trendLimited = false
    try {
      usage = await query('usage', filters, controller.signal)
    } catch (error) {
      if (id !== sequence || error.message !== 'bucket_range_too_large') throw error
      const totalsOnly = new URLSearchParams(filters)
      totalsOnly.delete('bucket')
      usage = await query('usage', totalsOnly, controller.signal)
      trendLimited = true
    }
    if (id !== sequence) return
    showSummary(usage, filters)
    shownQuery = fingerprint
    notice.textContent = trendLimited ? '此区间超出所选趋势粒度的上限。可切换粒度或缩短时间区间。' : ''
    const detailFilters = new URLSearchParams(filters)
    detailFilters.delete('bucket')
    detailFilters.delete('period')
    detailFilters.set('from', usage.range.from)
    detailFilters.set('to', usage.range.to)
    nextState = { filters: detailFilters, tokens: [null], index: 0, next: null, loaded: false }
    byId('rows-table').hidden = true
    byId('detail-rows').replaceChildren()
  } catch (error) {
    if (id === sequence) {
      notice.textContent = error.message === 'query_token_invalid' ? '查询会话已失效。请从后台诊断重新打开看板。'
        : sameQuery ? '本次读取失败。当前显示上次结果，可重新查询。' : '暂时无法读取用量。请重新查询。'
    }
  } finally {
    if (id === sequence) {
      results.setAttribute('aria-busy', 'false')
      activeRequest = undefined
      if (nextState) {
        pageState = nextState
        void loadRows(0)
      }
      rowsControls()
    }
  }
}

const filterForm = byId('filters')

function dispatchQuery(event) {
  event.preventDefault()
  filterForm.dispatchEvent(new Event('submit', { cancelable: true }))
}

byId('refresh').addEventListener('click', dispatchQuery)
filterForm.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing && event.target.tagName === 'INPUT') dispatchQuery(event)
})
filterForm.addEventListener('submit', event => {
  event.preventDefault()
  void refresh()
})
period.addEventListener('change', () => {
  const custom = period.value === 'custom'
  byId('custom-range').hidden = !custom
  if (custom) {
    if (shownRange) {
      byId('from').value ||= shownRange.from
      byId('to').value ||= shownRange.to
    }
    byId('from').focus()
    return
  }
  byId('bucket').value = period.value === 'today' ? 'hour' : 'day'
  void refresh()
})
byId('previous-rows').addEventListener('click', () => {
  if (pageState?.index) void loadRows(pageState.index - 1)
})
byId('next-rows').addEventListener('click', () => {
  if (pageState?.next) void loadRows(pageState.index + 1)
})
void refresh()
