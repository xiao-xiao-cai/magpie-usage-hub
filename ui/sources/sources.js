const byId = id => document.getElementById(id)
const sourcesPath = '../api/sources'
const adminToken = document.querySelector('meta[name="usage-admin-token"]')?.content
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })
const codePattern = /^[0-9a-f]{64}$/
const editEnabled = byId('edit-enabled')
const editInterval = byId('edit-interval')
const codeInput = byId('pairing-code')
let sources
let editing
let busy = false
let stale = false
let pairing
let pairingTimer

function time(value) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? dateTime.format(timestamp) : '暂无'
}

function connection(source) {
  if (!source.paired) return Date.parse(source.pairingExpiresAt) > Date.now() ? '待配对' : '配对码已过期'
  if (!source.enabled) return '采集已暂停'
  if (source.lastSeenAt === null) return '等待节点联系'
  const grace = Math.max(120, source.pollIntervalSec * 2) * 1_000
  return Date.now() - Date.parse(source.lastSeenAt) <= grace ? '近期在线' : '联系超时'
}

function readSource(value) {
  if (!value || typeof value.id !== 'string' || typeof value.name !== 'string'
    || typeof value.sourceCallerKeyId !== 'string' || typeof value.sourceProviderId !== 'string'
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isInteger(value.pollIntervalSec) || value.pollIntervalSec < 5 || value.pollIntervalSec > 900
    || typeof value.enabled !== 'boolean' || typeof value.paired !== 'boolean'
    || [value.pairingExpiresAt, value.lastSeenAt, value.lastReportAt].some(entry =>
      entry !== null && (typeof entry !== 'string' || !Number.isFinite(Date.parse(entry))))) throw new Error()
  return value
}

async function callSource(suffix, body) {
  if (typeof adminToken !== 'string' || !codePattern.test(adminToken)) throw new Error()
  const headers = { 'X-Magpie-Usage-Admin': adminToken }
  if (body) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${sourcesPath}${suffix}`, {
    headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('source_request_failed', { cause: response.status })
  return response.json()
}

function selected() {
  return sources?.find(source => source.id === editing?.id)
}

function edited() {
  return editing && (editEnabled.checked !== editing.enabled || editInterval.valueAsNumber !== editing.pollIntervalSec)
}

function updateControls() {
  const latest = selected()
  const conflict = latest && latest.revision !== editing.revision
  byId('refresh-sources').disabled = busy
  byId('add-fields').disabled = busy || sources === undefined
  byId('add-button').disabled = stale
  byId('edit-fields').disabled = busy || !latest
  byId('save-source').disabled = stale || Boolean(conflict)
  byId('renew-code').disabled = stale || Boolean(conflict)
  byId('renew-code').hidden = !latest || latest.paired
  byId('review-latest').hidden = !conflict
  byId('edit-conflict').hidden = !conflict
  byId('edit-conflict').textContent = conflict
    ? `中心设置已更新，当前已${latest.enabled ? '启用' : '暂停'}采集，间隔 ${latest.pollIntervalSec} 秒。草稿已保留。` : ''
  byId('sources-section').setAttribute('aria-busy', String(busy))
}

function editSource(source) {
  editing = source
  byId('editor').hidden = !source
  byId('edit-notice').textContent = ''
  if (source) {
    byId('edit-title').textContent = `来源设置 · ${source.name}`
    byId('edit-scope').textContent = `专用测试 Key ID ${source.sourceCallerKeyId} · 供应商 ${source.sourceProviderId}`
    editEnabled.checked = source.enabled
    editInterval.value = String(source.pollIntervalSec)
  }
  updateControls()
}

function clearPairing() {
  clearTimeout(pairingTimer)
  pairing = undefined
  codeInput.value = ''
  byId('pairing-summary').textContent = ''
  byId('pairing-result').hidden = true
  byId('pairing-value').hidden = true
  byId('reveal-code').textContent = '显示配对码'
  byId('reveal-code').setAttribute('aria-expanded', 'false')
}

function offerPairing(source, code) {
  clearPairing()
  const remaining = Date.parse(source.pairingExpiresAt) - Date.now()
  if (remaining <= 0) return
  pairing = { id: source.id, expiresAt: source.pairingExpiresAt, code }
  pairingTimer = setTimeout(clearPairing, remaining)
  byId('pairing-summary').textContent = `${source.name} · 有效期至 ${time(source.pairingExpiresAt)}`
  byId('pairing-result').hidden = false
  byId('reveal-code').focus()
}

function rowFor(source) {
  const row = document.createElement('tr')
  const title = document.createElement('th')
  title.scope = 'row'
  title.textContent = source.name
  const id = document.createElement('div')
  id.className = 'identifier muted'
  id.textContent = source.id
  title.append(id)
  row.append(title)
  for (const value of [connection(source), time(source.lastSeenAt), time(source.lastReportAt)]) {
    const cell = document.createElement('td')
    cell.textContent = value
    row.append(cell)
  }
  const actions = document.createElement('td')
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '设置'
  button.setAttribute('aria-label', `设置 ${source.name}`)
  button.addEventListener('click', () => {
    if (busy) return
    if (edited() && editing.id !== source.id) {
      byId('edit-notice').textContent = '请保存当前草稿，或关闭当前设置后再切换来源。'
      editInterval.focus()
      return
    }
    if (editing?.id !== source.id) editSource(source)
    editInterval.focus()
  })
  actions.append(button)
  row.append(actions)
  return row
}

function present(next) {
  sources = next
  const latest = selected()
  if (!latest || !edited()) editSource(latest)
  if (pairing && !sources.some(source => source.id === pairing.id && source.pairingExpiresAt === pairing.expiresAt
    && !source.paired)) clearPairing()
  byId('sources-rows').replaceChildren(...sources.map(rowFor))
  byId('sources-table').hidden = !sources.length
  byId('sources-empty').hidden = sources.length > 0
  updateControls()
}

async function loadSources() {
  const payload = await callSource('')
  if (!Array.isArray(payload?.sources)) throw new Error()
  const next = payload.sources.map(readSource)
  stale = false
  present(next)
  byId('sources-notice').textContent = `最近读取 ${time(new Date().toISOString())}`
}

async function refresh() {
  if (busy) return
  busy = true
  updateControls()
  byId('sources-notice').textContent = '正在读取来源…'
  try {
    await loadSources()
  } catch {
    byId('sources-notice').textContent = sources
      ? '刷新失败，显示上次读取的来源。可重试。' : '暂时无法读取来源。请刷新，或从 Magpie Web 重新打开此页。'
  } finally {
    busy = false
    updateControls()
  }
}

async function submit(suffix, body, notice, success, needsCode = false) {
  if (busy || stale || sources === undefined) return
  busy = true
  updateControls()
  notice.textContent = '正在保存…'
  try {
    const payload = await callSource(suffix, body)
    const source = readSource(payload?.source)
    if ((body.id !== undefined && source.id !== body.id)
      || (needsCode && (typeof payload.pairingCode !== 'string' || !codePattern.test(payload.pairingCode)
        || source.pairingExpiresAt === null || source.paired))) throw new Error()
    present([...sources.filter(entry => entry.id !== source.id), source].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')))
    success(source)
    if (needsCode) offerPairing(source, payload.pairingCode)
    notice.textContent = needsCode ? '配对码已生成。' : '来源设置已保存。'
  } catch (error) {
    const status = error?.cause
    if (status === 409 || status === 404) {
      stale = true
      try { await loadSources() } catch {}
      notice.textContent = stale ? '中心状态已变化，请刷新核对后再提交。草稿已保留。'
        : '已读取中心的新状态。请核对后再提交，草稿已保留。'
    } else {
      stale = status !== 400
      notice.textContent = status === 400 ? '请核对来源设置后再提交。草稿已保留。'
        : '本次保存结果待确认。请刷新核对后再提交，草稿已保留。'
    }
  } finally {
    busy = false
    updateControls()
  }
}

function bindSubmit(formId, buttonId, handler) {
  const form = byId(formId)
  const button = byId(buttonId)
  const submitForm = event => {
    event.preventDefault()
    if (!button.disabled && form.reportValidity()) form.dispatchEvent(new Event('submit', { cancelable: true }))
  }
  button.addEventListener('click', submitForm)
  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && event.target.tagName === 'INPUT'
      && event.target.type !== 'checkbox') submitForm(event)
  })
  form.addEventListener('submit', handler)
}

byId('refresh-sources').addEventListener('click', refresh)
bindSubmit('add-source', 'add-button', event => {
  event.preventDefault()
  const body = {
    name: byId('source-name').value.trim(), sourceCallerKeyId: byId('source-key').value.trim(),
    sourceProviderId: byId('source-provider').value.trim(), pollIntervalSec: byId('source-interval').valueAsNumber,
    enabled: byId('source-enabled').checked,
  }
  void submit('', body, byId('add-notice'), () => byId('add-source').reset(), true)
})
bindSubmit('edit-source', 'save-source', event => {
  event.preventDefault()
  if (!editing || byId('save-source').disabled) return
  void submit('/settings', { id: editing.id, revision: editing.revision, enabled: editEnabled.checked,
    pollIntervalSec: editInterval.valueAsNumber,
  }, byId('edit-notice'), editSource)
})
byId('renew-code').addEventListener('click', () => {
  if (!editing || byId('renew-code').disabled || selected()?.paired) return
  const { id, revision } = editing
  void submit('/pairing', { id, revision }, byId('edit-notice'), source => { editing = source }, true)
})
byId('review-latest').addEventListener('click', () => {
  const latest = selected()
  if (busy || !latest || !editing) return
  const draftEnabled = editEnabled.checked === editing.enabled ? latest.enabled : editEnabled.checked
  const draftInterval = editInterval.valueAsNumber === editing.pollIntervalSec ? String(latest.pollIntervalSec) : editInterval.value
  editSource(latest)
  editEnabled.checked = draftEnabled
  editInterval.value = draftInterval
  editInterval.focus()
})
byId('close-editor').addEventListener('click', () => editSource())
byId('dismiss-code').addEventListener('click', clearPairing)
byId('reveal-code').addEventListener('click', () => {
  if (!pairing) return
  const reveal = byId('pairing-value').hidden
  codeInput.value = reveal ? pairing.code : ''
  byId('pairing-value').hidden = !reveal
  byId('reveal-code').textContent = reveal ? '隐藏配对码' : '显示配对码'
  byId('reveal-code').setAttribute('aria-expanded', String(reveal))
  if (reveal) {
    codeInput.focus()
    codeInput.select()
  }
})
void refresh()
