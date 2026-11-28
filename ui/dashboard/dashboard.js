const byId = id => document.getElementById(id)
const queryToken = document.querySelector('meta[name="usage-query-token"]')?.content
const number = new Intl.NumberFormat('zh-CN')
const shortNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const dollars = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 10 })
const metricNames = { tokens: 'Token', calls: '次', cost: 'USD' }
const viaNames = { through: '网关', direct: '原生本机会话', session: 'OTLP 会话' }
const callsNotes = { through: '本机按原生请求，OTLP 按网关尝试', conversation: '本机按原生会话请求，OTLP 按会话生成', all: '全部分项，同次业务调用可能重叠' }
const scopeNames = { through: '网关', conversation: '会话', all: '全部分项' }
const periods = ['today', '7d', '30d', 'custom']
const metrics = Object.keys(metricNames)
const metricLabels = { tokens: 'Token', calls: '次数', cost: '已计价费用' }
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 })
const svgNamespace = 'http://www.w3.org/2000/svg'
const urlState = new URLSearchParams(usageHubOptions.dashboardSearch(location.search))
const state = {
  view: urlState.get('view') || 'overview', period: urlState.get('period') || '7d',
  via: urlState.get('via') || 'through', metric: urlState.get('metric') || 'tokens',
  bucket: urlState.get('bucket') || 'auto', sourceId: urlState.get('sourceId') || '', model: urlState.get('model'),
  from: urlState.get('from') || '', to: urlState.get('to') || '',
  detailFrom: urlState.get('detailFrom') || '', detailTo: urlState.get('detailTo') || '',
}
let usage
let activeRequest
let rowsRequest
let retryTimer
let retryRange
let pageState
let timeFormats
let chartPoints = []
let selectedPoint = 0
const expandedModels = new Set()

const timestamp = usageHubOptions.dashboardTimestamp
function validRange(from, to) { return timestamp(from) < timestamp(to) }

if (state.period === 'custom' && !validRange(state.from, state.to)) state.period = '7d'
byId('from').value = validRange(state.from, state.to) ? state.from : ''
byId('to').value = validRange(state.from, state.to) ? state.to : ''
byId('via').value = state.via

function updateNavigation() {
  const params = new URLSearchParams({ view: state.view, period: state.period, via: state.via })
  if (state.period === 'custom') { params.set('from', state.from); params.set('to', state.to) }
  if (state.sourceId) params.set('sourceId', state.sourceId)
  if (state.model !== null) params.set('model', state.model)
  if (state.metric !== 'tokens') params.set('metric', state.metric)
  if (state.bucket !== 'auto') params.set('bucket', state.bucket)
  if (state.detailFrom) { params.set('detailFrom', state.detailFrom); params.set('detailTo', state.detailTo) }
  const search = usageHubOptions.dashboardSearch(`?${params}`)
  if (search !== location.search) history.replaceState(null, '', search)
  const settings = `../sources/?${new URLSearchParams({ back: search })}`
  byId('settings').href = settings
  byId('register').href = `${settings}#add`
  for (const [group, options] of [['view', ['overview', 'details']], ['period', periods], ['metric', metrics]]) {
    for (const option of options) byId(`${group}-${option}`).setAttribute('aria-pressed', String(state[group] === option))
  }
  byId('overview').hidden = state.view !== 'overview'
  byId('rows-section').hidden = state.view !== 'details'
  byId('model-field').hidden = state.view !== 'details'
  byId('bucket').value = state.bucket
  byId('detail-range').hidden = !state.detailFrom || !timeFormats
  byId('back-overview').hidden = !state.detailFrom
  if (state.detailFrom && timeFormats) byId('detail-range').textContent = formatRange(state.detailFrom, state.detailTo)
}

function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

function cell(row, value, heading = false) {
  const node = element(heading ? 'th' : 'td', value)
  if (heading) node.scope = 'row'
  row.append(node)
  return node
}

function note(parent, text) { parent.append(element('small', text, 'detail-meta')) }
function pair(left, right) { return `${number.format(left)} / ${number.format(right)}` }
function tokens(totals) { return totals.input + totals.output }
function cost(value) { return value > 0 && value < 1e-10 ? '<$0.0000000001' : `$${dollars.format(value)}` }

function createTimeFormats(timeZone) {
  const format = options => new Intl.DateTimeFormat('zh-CN', { timeZone, ...options })
  const day = { month: 'short', day: 'numeric' }
  const clock = { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }
  return {
    day: format(day), date: format({ ...day, year: 'numeric' }), year: format({ year: 'numeric' }),
    clock: format(clock), full: format({ ...clock, year: 'numeric', month: 'numeric', day: 'numeric' }),
  }
}

function formatRange(from, to) {
  const start = Date.parse(from)
  const end = Date.parse(to)
  const { clock, date, day, year } = timeFormats
  const currentYear = year.format(Date.parse(usage.readAt))
  const dateLabel = instant => (year.format(instant) === currentYear ? day : date).format(instant)
  const clockLabel = instant => clock.format(instant).replace(/:00$/, '')
  const endDate = date.format(start) === date.format(end) ? '' : `${dateLabel(end)} `
  return `${dateLabel(start)} ${clockLabel(start)} – ${endDate}${clockLabel(end)}`
}

function compactValue(node, value, label) {
  node.textContent = value === null ? '—' : shortNumber.format(value)
  const exact = `${label} ${value === null ? '—' : number.format(value)}`
  node.tabIndex = value === null ? -1 : 0
  node.setAttribute('class', 'exact-value')
  node.setAttribute('role', 'group')
  node.setAttribute('data-exact', exact)
  node.setAttribute('aria-label', exact)
}

function appendTime(parent, value, today) {
  const instant = Date.parse(value)
  const date = timeFormats.date.format(instant) === today ? '' : `${timeFormats.day.format(instant)} `
  const time = element('time', `${date}${timeFormats.clock.format(instant)}`)
  time.dateTime = value
  time.title = timeFormats.full.format(instant)
  parent.append(time)
}

function emptyTotals() { return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, unpriced: 0, cacheUnknownCalls: 0 } }
function addTotals(sum, totals) { for (const key of Object.keys(sum)) sum[key] += totals[key] ?? 0 }

function combine(sources, field, key) {
  const groups = new Map()
  for (const source of sources) {
    for (const item of source[field]) {
      if (!groups.has(item[key])) groups.set(item[key], { ...item, totals: emptyTotals() })
      addTotals(groups.get(item[key]).totals, item.totals)
    }
  }
  return [...groups.values()]
}

function grain() {
  if (state.bucket !== 'auto') return state.bucket
  return state.period === 'today' || (state.period === 'custom' && timestamp(state.to) - timestamp(state.from) <= 86_400_000) ? 'hour' : 'day'
}

function summaryParams() {
  const params = new URLSearchParams()
  if (state.period === 'custom') { params.set('from', state.from); params.set('to', state.to) }
  else params.set('period', state.period)
  if (state.via !== 'all') params.set('via', state.via)
  return params
}

function matchesSummary() { return usage?.key === summaryParams().toString() }

async function query(path, params, signal) {
  if (!/^[0-9a-f]{64}$/u.test(queryToken ?? '')) throw new Error('query_token_invalid')
  const response = await fetch(`../api/${path}?${params}`, { headers: { 'X-Magpie-Usage-Query': queryToken },
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
  if (response.status === 403) throw new Error('query_token_invalid')
  if (response.status === 503) throw new Error('unavailable')
  if (!response.ok) {
    const problem = await response.json().catch(() => null)
    const code = problem?.error?.code
    throw new Error(['bucket_range_too_large', 'invalid_page'].includes(code) ? code : 'query_failed')
  }
  return response.json()
}

function setOptions(id, items, value) {
  const select = byId(id)
  select.replaceChildren(...items.map(([key, label]) => {
    const option = element('option', label)
    option.value = key
    return option
  }))
  select.value = value
}

function selectSource(sourceId) {
  state.sourceId = sourceId
  state.model = null
  resetRows()
  render()
  if (state.view === 'details') void loadRows(0)
}

function chartPath(values, width, height, inset) {
  const max = Math.max(0, ...values) || 1
  const coordinates = values.map((value, index) => {
    const horizontal = values.length === 1 ? width / 2 : index * width / (values.length - 1)
    return `${horizontal.toFixed(2)} ${(height - inset - value / max * (height - 2 * inset)).toFixed(2)}`
  })
  return values.length === 1 ? `M${coordinates[0]}h0.1` : `M${coordinates.join('L')}`
}

function metricShare(totals, denominator, published = true) {
  const ratio = published && denominator > 0 ? metricValue(totals) / denominator : null
  const share = element('span', undefined, 'list-share')
  const bar = element('meter')
  bar.setAttribute('aria-hidden', 'true')
  bar.min = 0
  bar.max = 1
  bar.value = ratio ?? 0
  share.append(bar, element('span', ratio === null ? '—' : percent.format(ratio)))
  return share
}

function sourceCard(source, denominator) {
  const item = element('li')
  const button = element('button', undefined, 'panel source-card')
  const name = element('span', source.name, 'source-name')
  const totals = source.totals
  const amount = element('strong', source.hasPublishedData ? metricText(totals) : '—', 'source-value')
  const secondaryMetrics = [
    ...(state.metric === 'tokens' ? [] : [`${number.format(tokens(totals))} Token`]),
    ...(state.metric === 'calls' ? [] : [`${number.format(totals.calls)} 次`]),
    ...(state.metric === 'cost' ? [] : [`${cost(totals.cost)} 已计价`]),
    ...(totals.unpriced ? [`缺价 ${number.format(totals.unpriced)} 条`] : []),
  ]
  const secondary = element('span', source.hasPublishedData ? secondaryMetrics.join(' · ') : '用量准备中', 'detail-meta source-meta')
  const sparkline = element('span', undefined, 'source-sparkline')
  if (source.buckets.length) {
    const spark = document.createElementNS(svgNamespace, 'svg')
    spark.setAttribute('viewBox', '0 0 100 24')
    spark.setAttribute('aria-hidden', 'true')
    const line = document.createElementNS(svgNamespace, 'path')
    line.setAttribute('class', 'trend-line')
    line.setAttribute('d', chartPath(source.buckets.map(bucket => metricValue(bucket.totals)), 100, 24, 2))
    spark.append(line)
    sparkline.append(spark)
  }
  button.id = `source-card-${source.id}`
  name.id = `source-name-${source.id}`
  amount.id = `source-value-${source.id}`
  secondary.id = `source-meta-${source.id}`
  const share = metricShare(totals, denominator, source.hasPublishedData)
  share.id = `source-share-${source.id}`
  button.type = 'button'
  button.setAttribute('aria-labelledby', name.id)
  button.setAttribute('aria-describedby', `${amount.id} ${secondary.id} ${share.id}`)
  button.setAttribute('aria-pressed', String(state.sourceId === source.id))
  button.addEventListener('click', () => {
    selectSource(state.sourceId === source.id ? '' : source.id)
    byId(button.id)?.focus({ preventScroll: true })
  })
  button.append(name, amount, secondary, sparkline, share)
  item.append(button)
  return item
}

function selectView(view) {
  if (view === 'overview' && state.detailFrom) {
    state.detailFrom = ''
    state.detailTo = ''
    resetRows()
  }
  state.view = view
  updateNavigation()
  renderBilling()
  if (view === 'overview' && rowsRequest) {
    rowsRequest.abort()
    rowsRequest = undefined
    byId('rows-notice').textContent = ''
    rowsControls()
  } else if (view === 'details' && !pageState?.loaded) void loadRows(0)
}

function modelRow(item, denominator, index) {
  const row = element('li', undefined, 'usage-row model-row')
  const link = element('button', item.model || '未标注模型', 'text-action')
  link.type = 'button'
  link.addEventListener('click', () => {
    state.detailFrom = ''
    state.detailTo = ''
    state.model = item.model
    byId('model').value = `model:${item.model}`
    resetRows()
    selectView('details')
    byId('model').focus()
  })
  const totals = item.totals
  const details = element('dl', undefined, 'model-details')
  details.id = `model-fields-${index}`
  for (const [label, value] of [
    ['输入 / 输出', pair(totals.input, totals.output)],
    ['缓存读 / 写', pair(totals.cacheRead, totals.cacheWrite)],
    ['缓存未知', number.format(totals.cacheUnknownCalls)],
    ['推理 Token', number.format(totals.reasoning)],
    ['次数', number.format(totals.calls)],
    ['已计价费用', cost(totals.cost)],
    ['缺价记录', number.format(totals.unpriced)],
  ]) {
    const field = element('div')
    field.append(element('dt', label), element('dd', value))
    details.append(field)
  }
  const toggle = element('button', '细项', 'quiet list-action')
  toggle.type = 'button'
  toggle.setAttribute('aria-label', `细项 ${link.textContent}`)
  toggle.setAttribute('aria-controls', details.id)
  const expand = open => {
    details.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    if (open) expandedModels.add(item.model)
    else expandedModels.delete(item.model)
  }
  expand(expandedModels.has(item.model))
  toggle.addEventListener('click', () => expand(details.hidden))
  const amount = element('span', metricText(totals), 'list-number')
  if (state.metric === 'cost' && totals.unpriced) note(amount, `缺价 ${number.format(totals.unpriced)} 条`)
  row.append(link, amount, metricShare(totals, denominator), toggle, details)
  return row
}

function metricValue(totals) { return state.metric === 'tokens' ? tokens(totals) : totals[state.metric] }
function metricText(totals) { return state.metric === 'cost' ? cost(totals.cost) : `${number.format(metricValue(totals))} ${metricNames[state.metric]}` }

function inspectPoint(index) {
  if (!chartPoints.length) return
  selectedPoint = Math.max(0, Math.min(chartPoints.length - 1, index))
  const point = chartPoints[selectedPoint]
  const totals = point.totals
  const time = formatRange(point.from, point.to)
  const values = `${number.format(tokens(totals))} Token · 输入 / 输出 ${pair(totals.input, totals.output)} · ${number.format(totals.calls)} 次 · ${cost(totals.cost)} 已计价 · 缺价 ${number.format(totals.unpriced)} 条`
  byId('point-time').textContent = time
  byId('point-value').textContent = values
  const horizontal = chartPoints.length === 1 ? 500 : selectedPoint * 1000 / (chartPoints.length - 1)
  byId('point-guide').setAttribute('d', `M${horizontal} 4V120`)
  byId('plot').setAttribute('aria-valuenow', String(selectedPoint + 1))
  byId('plot').setAttribute('aria-valuetext', `${time} · ${values}`)
}

function openBucketDetails() {
  if (!matchesSummary() || activeRequest || !chartPoints.length) return
  const point = chartPoints[selectedPoint]
  state.detailFrom = point.from
  state.detailTo = point.to
  state.model = null
  byId('model').value = ''
  resetRows()
  selectView('details')
  byId('rows-heading').focus()
}

function renderChart() {
  byId('grain').textContent = usage.trendLimited ? '' : usage.grain === 'hour' ? '按小时' : usage.hourLimited ? '按日 · 所选区间超过小时趋势上限' : '按日'
  byId('chart').hidden = chartPoints.length === 0
  byId('trend-empty').hidden = chartPoints.length > 0
  if (!chartPoints.length) {
    byId('trend-empty').textContent = usage.trendLimited ? '所选区间超过趋势上限，可缩短起止时间。' : '所选范围内暂无趋势数据。'
    return
  }
  const values = chartPoints.map(point => metricValue(point.totals))
  const max = Math.max(...values)
  const line = chartPath(values, 1000, 124, 4)
  byId('trend-line').setAttribute('d', line)
  byId('trend-area').setAttribute('d', values.length > 1 ? `${line}L1000 120H0Z` : '')
  byId('plot').setAttribute('aria-valuemax', String(values.length))
  const ticks = max ? [max, max / 2, 0] : [0]
  byId('y-axis').replaceChildren(...ticks.map(value => element('span', state.metric === 'cost' ? cost(value) : shortNumber.format(value))))
  const indices = [...new Set([0, Math.floor((values.length - 1) / 2), values.length - 1])]
  const multiDay = timestamp(usage.range.to) - timestamp(usage.range.from) > 86_400_000
  byId('x-axis').replaceChildren(...indices.map(index => {
    const instant = Date.parse(chartPoints[index].from)
    const day = timeFormats.day.format(instant)
    const hour = timeFormats.clock.format(instant).slice(0, 2)
    return element('span', usage.grain === 'hour' ? (multiDay ? `${day} ${hour}` : hour) : day)
  }))
  inspectPoint(selectedPoint)
}

function renderLists(sources, totals) {
  const denominator = usage.sources.reduce((sum, source) => sum + metricValue(source.totals), 0)
  byId('source-metric').textContent = `${metricLabels[state.metric]}占比`
  byId('summary-rows').replaceChildren(...usage.sources.map(source => sourceCard(source, denominator)))
  const models = combine(sources, 'models', 'model').sort((left, right) => metricValue(right.totals) - metricValue(left.totals) || left.model.localeCompare(right.model))
  byId('model-sort').textContent = `按${metricLabels[state.metric]}降序`
  byId('model-rows').replaceChildren(...models.map((item, index) => modelRow(item, metricValue(totals), index)))
  byId('models-empty').hidden = models.length > 0
  byId('model-rows').hidden = models.length === 0
  return models
}

function visibleSources() { return usage.sources.filter(source => !state.sourceId || source.id === state.sourceId) }

function renderBilling() {
  if (!matchesSummary()) return
  const sources = visibleSources()
  const totals = emptyTotals()
  for (const source of sources) {
    const item = state.view === 'details' && state.model !== null ? source.models.find(item => item.model === state.model) : source
    if (item) addTotals(totals, item.totals)
  }
  byId('billing').hidden = state.view === 'details' && Boolean(state.detailFrom)
  byId('billed').textContent = sources.some(source => source.hasPublishedData) ? `${cost(totals.cost)} USD` : '—'
  byId('unpriced').hidden = !totals.unpriced
  byId('unpriced').textContent = `缺价 ${number.format(totals.unpriced)} 条`
}

function render() {
  if (!matchesSummary()) return
  const sources = visibleSources()
  const published = sources.some(source => source.hasPublishedData)
  const totals = emptyTotals()
  for (const source of sources) addTotals(totals, source.totals)
  byId('register-banner').hidden = !(usage.sources.length === 1 && usage.sources[0].id === 'local')
  renderBilling()
  compactValue(byId('kpi-tokens'), published ? tokens(totals) : null, 'Token')
  byId('token-note').textContent = published ? `输入 ${number.format(totals.input)} / 输出 ${number.format(totals.output)}` : '输入 — / 输出 —'
  compactValue(byId('kpi-cache'), published ? totals.cacheRead : null, '缓存读取')
  byId('cache-note').textContent = published ? `缓存写入 ${number.format(totals.cacheWrite)}${totals.cacheUnknownCalls ? ` · ${number.format(totals.cacheUnknownCalls)} 条缓存未知` : ''}` : '缓存写入 —'
  compactValue(byId('kpi-reasoning'), published ? totals.reasoning : null, '推理 Token')
  compactValue(byId('kpi-calls'), published ? totals.calls : null, '计量次数')
  byId('calls-note').textContent = callsNotes[usage.via]
  byId('range-label').textContent = `${scopeNames[usage.via]} · ${formatRange(usage.range.from, usage.range.to)}`
  const readAt = byId('read-at')
  const readInstant = Date.parse(usage.readAt)
  readAt.dateTime = usage.readAt
  readAt.textContent = timeFormats.clock.format(readInstant)
  readAt.title = timeFormats.full.format(readInstant)
  setOptions('source', [['', '全部来源'], ...usage.sources.map(source => [source.id, source.name])], state.sourceId)
  const models = renderLists(sources, totals)
  byId('usage-empty').hidden = models.length > 0
  byId('usage-empty').textContent = published ? '此时段暂无用量' : '用量准备中'
  const names = models.map(item => item.model)
  if (state.model !== null && !names.includes(state.model)) names.push(state.model)
  setOptions('model', [['', '全部模型'], ...names.map(name => [`model:${name}`, name || '未标注模型'])], state.model === null ? '' : `model:${state.model}`)
  const previousPoint = chartPoints[selectedPoint]?.from
  chartPoints = combine(sources, 'buckets', 'from').sort((left, right) => Date.parse(left.from) - Date.parse(right.from))
  const previousIndex = chartPoints.findIndex(point => point.from === previousPoint)
  selectedPoint = previousIndex < 0 ? chartPoints.length - 1 : previousIndex
  renderChart()
  updateNavigation()
  byId('results').hidden = false
}

function detailRow(item, today) {
  const row = element('tr')
  const source = usage.sources.find(source => source.id === item.sourceId)
  const primaryUsage = item.input + item.output > 0
  const isOtlp = source?.transport === 'otlp'
  const hasUsage = primaryUsage || (isOtlp && item.cacheRead + item.cacheWrite > 0)
  appendTime(cell(row, '', true), item.t, today)
  cell(row, source?.name ?? '来源')
  cell(row, item.model || '未标注模型')
  const via = cell(row, viaNames[item.via] ?? '未标注分项')
  if (item.handedOn) note(via, '中间尝试')
  cell(row, pair(item.input, item.output))
  const cache = cell(row, pair(item.cacheRead, item.cacheWrite))
  if (item.cacheUnknown) note(cache, '缓存计数未知')
  cell(row, number.format(item.reasoning))
  cell(row, item.cost !== null && (primaryUsage || isOtlp) ? cost(item.cost) : hasUsage ? '缺价' : '—')
  cell(row, item.status == null ? '—' : String(item.status))
  cell(row, item.durationMs == null ? '—' : number.format(item.durationMs))
  return row
}

function rowsControls() {
  byId('row-pages').hidden = !(pageState?.loaded && (pageState.index || pageState.next))
  byId('previous-rows').disabled = Boolean(rowsRequest || activeRequest || !pageState?.index)
  byId('next-rows').disabled = Boolean(rowsRequest || activeRequest || !pageState?.next)
  byId('rows-section').setAttribute('aria-busy', String(Boolean(rowsRequest)))
  byId('bucket-details').disabled = Boolean(activeRequest)
}

function resetRows() {
  rowsRequest?.abort()
  rowsRequest = undefined
  pageState = { tokens: [null], index: 0, next: null, loaded: false, retryIndex: 0 }
  byId('rows-table').hidden = true
  byId('rows-retry').hidden = true
  byId('rows-reload').hidden = true
  byId('detail-rows').replaceChildren()
  byId('rows-notice').textContent = ''
  rowsControls()
}

async function loadRows(index) {
  if (!matchesSummary() || state.view !== 'details' || activeRequest || rowsRequest) return
  const params = new URLSearchParams({ from: state.detailFrom || usage.range.from, to: state.detailTo || usage.range.to })
  if (state.sourceId) params.set('sourceId', state.sourceId)
  if (state.model !== null) params.set('model', state.model)
  if (usage.via !== 'all') params.set('via', usage.via)
  if (pageState.tokens[index]) params.set('page', pageState.tokens[index])
  const controller = new AbortController()
  rowsRequest = controller
  byId('rows-notice').textContent = '正在读取明细…'
  byId('rows-retry').hidden = true
  byId('rows-reload').hidden = true
  rowsControls()
  try {
    const details = await query('usage/rows', params, controller.signal)
    if (controller !== rowsRequest) return
    const today = timeFormats.date.format(new Date())
    byId('detail-rows').replaceChildren(...details.rows.map(item => detailRow(item, today)))
    byId('rows-table').hidden = !details.rows.length
    byId('rows-notice').textContent = details.rows.length ? '' : visibleSources().some(source => source.hasPublishedData) ? '此时段暂无用量' : '用量准备中'
    byId('current-page').textContent = `第 ${number.format(index + 1)} 页`
    pageState.index = index
    pageState.next = details.nextPage
    pageState.tokens[index + 1] = details.nextPage
    pageState.loaded = true
  } catch (error) {
    if (controller !== rowsRequest) return
    if (error.message === 'invalid_page' && pageState.tokens[index]) {
      rowsRequest = undefined
      resetRows()
      void loadRows(0)
      return
    }
    const expired = error.message === 'query_token_invalid'
    pageState.retryIndex = index
    byId('rows-reload').hidden = !expired
    byId('rows-retry').hidden = expired
    byId('rows-notice').textContent = expired ? '查询会话已失效。请重新加载页面。' : '明细暂时不可用，请重试。'
  } finally {
    if (controller === rowsRequest) { rowsRequest = undefined; rowsControls() }
  }
}

async function refresh(startupRetries = 0, pinnedRange) {
  clearTimeout(retryTimer)
  activeRequest?.abort()
  const controller = new AbortController()
  activeRequest = controller
  const params = summaryParams()
  const key = params.toString()
  const requestedGrain = grain()
  if (pinnedRange) {
    params.delete('period')
    params.set('from', pinnedRange.from)
    params.set('to', pinnedRange.to)
  }
  const sameScope = usage?.key === key
  retryRange = pinnedRange
  if (sameScope) {
    if (byId('results').hidden) render()
  } else {
    byId('results').hidden = true
    byId('billing').hidden = true
    byId('register-banner').hidden = true
    resetRows()
  }
  byId('loading').hidden = sameScope
  rowsControls()
  byId('results').setAttribute('aria-busy', 'true')
  byId('notice').textContent = sameScope ? '正在刷新，当前显示上次成功读取的结果。' : '正在读取用量…'
  byId('retry').hidden = true
  byId('reload').hidden = true
  try {
    let data, bucket = requestedGrain
    for (;;) {
      if (bucket) params.set('bucket', bucket)
      else params.delete('bucket')
      try { data = await query('usage', params, controller.signal); break }
      catch (error) {
        if (error.message !== 'bucket_range_too_large' || !bucket || controller !== activeRequest) throw error
        bucket = bucket === 'hour' ? 'day' : null
      }
    }
    if (controller !== activeRequest) return
    if (!validRange(data.range.from, data.range.to) || !Array.isArray(data.sources)) throw new Error('query_failed')
    const nextTimeFormats = createTimeFormats(data.range.timeZone)
    const sources = data.sources.sort((left, right) => Number(right.id === 'local') - Number(left.id === 'local') || left.name.localeCompare(right.name))
    usage = { ...data, sources, key, readAt: new Date().toISOString(), grain: bucket, via: state.via,
      hourLimited: requestedGrain === 'hour' && bucket === 'day', trendLimited: !bucket }
    timeFormats = nextTimeFormats
    const missingSource = state.sourceId && !sources.some(source => source.id === state.sourceId)
    if (missingSource) { state.sourceId = ''; state.model = null }
    if (!pinnedRange || missingSource) resetRows()
    render()
    byId('notice').textContent = missingSource ? '原筛选的来源已不可用，现显示全部来源。' : ''
  } catch (error) {
    if (controller !== activeRequest) return
    const expired = error.message === 'query_token_invalid'
    const retrying = error.message === 'unavailable' && startupRetries > 0 && !usage
    const message = expired ? '查询会话已失效。请重新加载页面。' : retrying ? '中心服务正在准备，将自动重试。' : '暂时无法读取用量，请重试。'
    byId('notice').textContent = `${message}${sameScope ? ' 当前显示上次成功读取的结果。' : ''}`
    byId('retry').hidden = expired
    byId('reload').hidden = !expired
    if (retrying) retryTimer = setTimeout(() => { void refresh(startupRetries - 1) }, 1500)
  } finally {
    if (controller === activeRequest) {
      activeRequest = undefined
      byId('loading').hidden = true
      byId('results').setAttribute('aria-busy', 'false')
      rowsControls()
      if (!pageState?.loaded) void loadRows(0)
    }
  }
}

for (const period of periods) byId(`period-${period}`).addEventListener('click', () => {
  byId('range-error').textContent = ''
  byId('custom-range').hidden = period !== 'custom'
  byId('period-custom').setAttribute('aria-expanded', String(period === 'custom'))
  if (period === 'custom') {
    if (!byId('from').value && usage) { byId('from').value = usage.range.from; byId('to').value = usage.range.to }
    byId('from').focus()
    return
  }
  if (state.period === period) return
  state.period = period
  state.detailFrom = state.detailTo = ''
  updateNavigation()
  void refresh()
})

function applyCustomRange(event) {
  event.preventDefault()
  const from = byId('from').value.trim()
  const to = byId('to').value.trim()
  if (!validRange(from, to)) { byId('range-error').textContent = '请填写含时区的有效起止时间，结束须晚于开始，时间精度最多为毫秒。'; return }
  Object.assign(state, { period: 'custom', from, to })
  state.detailFrom = state.detailTo = ''
  byId('range-error').textContent = ''
  updateNavigation()
  void refresh()
}

byId('custom-range').addEventListener('submit', applyCustomRange)
byId('apply-range').addEventListener('click', applyCustomRange)
for (const field of ['from', 'to']) byId(field).addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) applyCustomRange(event)
})
byId('via').addEventListener('change', () => { state.via = byId('via').value; updateNavigation(); void refresh() })
byId('source').addEventListener('change', () => selectSource(byId('source').value))
byId('model').addEventListener('change', () => {
  const model = byId('model').value
  state.model = model.startsWith('model:') ? model.slice(6) : null
  updateNavigation()
  renderBilling()
  resetRows()
  void loadRows(0)
})
for (const view of ['overview', 'details']) byId(`view-${view}`).addEventListener('click', () => selectView(view))
byId('bucket').addEventListener('change', () => {
  state.bucket = byId('bucket').value
  updateNavigation()
  void refresh(0, matchesSummary() ? usage.range : undefined)
})
for (const metric of metrics) byId(`metric-${metric}`).addEventListener('click', () => { state.metric = metric; render() })
byId('bucket-details').addEventListener('click', openBucketDetails)
byId('back-overview').addEventListener('click', () => {
  selectView('overview')
  byId(chartPoints.length ? 'plot' : 'view-overview').focus()
})
for (const type of ['pointermove', 'pointerdown']) byId('plot').addEventListener(type, event => {
  const bounds = byId('plot').getBoundingClientRect()
  if (bounds.width) inspectPoint(Math.round((event.clientX - bounds.left) / bounds.width * (chartPoints.length - 1)))
})
byId('plot').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); openBucketDetails(); return }
  const keys = { ArrowLeft: selectedPoint - 1, ArrowDown: selectedPoint - 1,
    ArrowRight: selectedPoint + 1, ArrowUp: selectedPoint + 1, Home: 0, End: chartPoints.length - 1 }
  if (Object.hasOwn(keys, event.key)) { event.preventDefault(); inspectPoint(keys[event.key]) }
})
byId('refresh').addEventListener('click', () => { void refresh() })
byId('retry').addEventListener('click', () => { void refresh(0, retryRange) })
for (const id of ['reload', 'rows-reload']) byId(id).addEventListener('click', () => location.reload())
byId('rows-retry').addEventListener('click', () => { void loadRows(pageState.retryIndex) })
byId('previous-rows').addEventListener('click', () => { if (pageState.index) void loadRows(pageState.index - 1) })
byId('next-rows').addEventListener('click', () => { if (pageState.next) void loadRows(pageState.index + 1) })
byId('custom-range').hidden = state.period !== 'custom'
byId('period-custom').setAttribute('aria-expanded', String(state.period === 'custom'))
updateNavigation()
void refresh(3)
