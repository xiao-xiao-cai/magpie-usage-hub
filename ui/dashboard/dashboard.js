const byId = id => document.getElementById(id)
const period = byId('period')
const scope = byId('scope')
const results = byId('results')
const summaryRows = byId('summary-rows')
const detailRows = byId('detail-rows')
const detailTable = byId('detail-table')
const detailNotice = byId('detail-notice')
const previous = byId('previous')
const next = byId('next')
const numbers = new Intl.NumberFormat('zh-CN')
const dollars = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 10 })
const scopes = ['through', 'direct', 'reported']
let sequence = 0
let activeRequest
let shown
let offset = 0

function cell(row, value, className = '', heading = false) {
  const element = document.createElement(heading ? 'th' : 'td')
  if (heading) element.scope = 'row'
  element.className = className
  element.textContent = value
  row.append(element)
  return element
}

function formatCount(value) {
  return numbers.format(value)
}

function pair(left, right) {
  return `${formatCount(left)} / ${formatCount(right)}`
}

function cost(value) {
  if (value === null) return '缺价'
  return value > 0 && value < 0.0000000001 ? '<0.0000000001' : dollars.format(value)
}

function summaryRow(label, totals, identifier = false, combined = false) {
  const row = document.createElement('tr')
  if (combined) row.className = 'combined'
  cell(row, label, identifier ? 'identifier' : '', true)
  const values = totals ? [
    formatCount(totals.attempts), pair(totals.input, totals.output), pair(totals.cacheRead, totals.cacheWrite),
    cost(totals.attempts > 0 && totals.unpriced === totals.attempts ? null : totals.cost), formatCount(totals.unpriced),
  ] : ['暂不可用', '—', '—', '—', '—']
  for (const value of values) cell(row, value, totals ? '' : 'muted')
  return row
}

function updateSources(sources, selected) {
  const labels = new Map(sources.map(({ id, name }) => [id, name || id]))
  if (!scopes.includes(selected) && !labels.has(selected)) labels.set(selected, selected)
  byId('source-options').replaceChildren(...Array.from(labels, ([id, label]) => {
    const option = document.createElement('option')
    option.value = id
    option.textContent = label
    if (label !== id) option.title = id
    return option
  }))
  scope.value = selected
}

function showDetail(detail, displayTime, pending = false) {
  detailTable.hidden = !detail?.rows.length
  detailNotice.hidden = !detailTable.hidden
  detailNotice.textContent = !detail ? (pending ? '正在读取明细…' : '该分项明细暂不可用。')
    : detail.total ? '这一页没有记录。' : '该范围内暂无记录。'
  detailRows.replaceChildren(...(detail?.rows ?? []).map(entry => {
    const row = document.createElement('tr')
    cell(row, displayTime.format(Date.parse(entry.time)), 'called-at')
    const model = cell(row, entry.provider || '—', 'model')
    const modelName = document.createElement('div')
    modelName.textContent = entry.model || '—'
    model.append(modelName)
    cell(row, entry.canceled ? `${entry.status ?? ''} 已取消`.trim() : String(entry.status ?? '未记录'))
    cell(row, pair(entry.input, entry.output))
    cell(row, pair(entry.cacheRead, entry.cacheWrite))
    cell(row, cost(entry.cost))
    const record = cell(row, entry.sourceInstanceId ?? '—', 'record-id')
    if (entry.rid) {
      const rid = document.createElement('div')
      rid.textContent = entry.rid
      record.append(rid)
    }
    return row
  }))
  const shownEnd = detail ? detail.offset + detail.rows.length : 0
  byId('page').textContent = !detail ? '—' : detail.rows.length
    ? `${formatCount(detail.offset + 1)}–${formatCount(shownEnd)} / ${formatCount(detail.total)}`
    : `共 ${formatCount(detail.total)} 条`
  previous.setAttribute('aria-disabled', String(!detail || detail.offset === 0))
  next.setAttribute('aria-disabled', String(!detail || shownEnd >= detail.total))
}

function showUsage(usage, selected) {
  const { totals, window, sources, detail } = usage
  const displayTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: window.timeZone })
  const windowNote = window.basis === 'native' ? '' : ' · 上报按中心日历日暂计'
  byId('window').textContent = `统计起点：${displayTime.format(Date.parse(window.since))} · ${window.timeZone}${windowNote}`
  summaryRows.replaceChildren(
    summaryRow('合计', totals.combined, false, true), summaryRow('中心本机', totals.local),
    summaryRow('中心本机 · 网关', totals.through), summaryRow('中心本机 · 直连', totals.direct),
    summaryRow('上报来源合计', totals.hub),
    ...(sources ?? []).map(source => summaryRow(source.name || source.id, source.totals, !source.name)),
  )
  updateSources(sources ?? [], selected)
  showDetail(detail, displayTime)
  const unavailable = [!totals.through && '中心网关', !totals.direct && '中心直连', !totals.hub && '上报账本'].filter(Boolean)
  const observedAt = displayTime.format(Date.now())
  byId('notice').textContent = unavailable.length
    ? `${unavailable.join('、')}暂不可用，合计待确认。${observedAt}` : `最近读取：${observedAt}`
  results.hidden = false
  return { displayTime, observedAt }
}

async function refresh() {
  const request = ++sequence
  activeRequest?.abort()
  activeRequest = new AbortController()
  const selected = scope.value
  const query = new URLSearchParams({ period: period.value, scope: selected, offset: String(offset) }).toString()
  const samePeriod = shown?.period === period.value
  const sameQuery = shown?.query === query
  results.hidden = !samePeriod
  results.setAttribute('aria-busy', 'true')
  byId('notice').textContent = '正在读取用量…'
  if (!sameQuery) showDetail(null, undefined, true)
  try {
    const response = await fetch(`../api/usage?${query}`, {
      cache: 'no-store', credentials: 'omit', redirect: 'error',
      signal: AbortSignal.any([activeRequest.signal, AbortSignal.timeout(125_000)]),
    })
    if (!response.ok) throw new Error()
    const usage = await response.json()
    if (usage?.schema !== 'magpie-usage-hub/usage-v1' || usage.period !== period.value
        || (usage.detail && usage.detail.scope !== selected)) throw new Error()
    if (request === sequence) {
      const displayed = showUsage(usage, selected)
      shown = { ...displayed, query, period: period.value, detail: usage.detail }
    }
  } catch {
    if (request === sequence) {
      if (sameQuery) showDetail(shown.detail, shown.displayTime)
      else showDetail(null)
      byId('notice').textContent = samePeriod
        ? `本次读取失败。显示 ${shown.observedAt} 的最近结果，可刷新重试。`
        : '暂时无法读取用量，可刷新重试。'
    }
  } finally {
    if (request === sequence) {
      results.setAttribute('aria-busy', 'false')
      activeRequest = undefined
    }
  }
}

function resetPage() {
  offset = 0
  return refresh()
}

function pageStep(button, direction) {
  if (button.getAttribute('aria-disabled') === 'true' || !shown?.detail) return
  const detail = shown.detail
  offset = Math.max(0, detail.offset + direction * detail.limit)
  return refresh()
}

byId('refresh').addEventListener('click', refresh)
period.addEventListener('change', resetPage)
scope.addEventListener('change', resetPage)
previous.addEventListener('click', () => pageStep(previous, -1))
next.addEventListener('click', () => pageStep(next, 1))
refresh()
