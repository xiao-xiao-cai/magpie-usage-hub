const byId = id => document.getElementById(id)
const sourcesPath = '../api/sources'
const adminToken = document.querySelector('meta[name="usage-admin-token"]')?.content
const form = byId('source-form')
const notice = byId('source-notice')
const testButton = byId('test-source')
const saveButton = byId('save-source')
const fields = {
  name: byId('source-name'), gatewayUrl: byId('source-gateway'), enabled: byId('source-enabled'), key: byId('source-key'),
}
const newSource = { name: '', gatewayUrl: '', enabled: true, credentialConfigured: false }
const failures = new Map([
  ['unauthorized', '网关未接受此 Key。'], ['forbidden', '网关拒绝访问。请核对允许地址和 Key 权限。'],
  ['timeout', '连接超时。请核对网关地址和网络。'], ['unavailable', '网关不可达或服务异常。'],
  ['incompatible_response', '网关响应不兼容。请核对来源的 Magpie 版本。'], ['redirect', '网关返回重定向。请填写最终网关根地址。'],
  ['restricted_key', '此 Key 的用量范围受限。请检查模型、账户与预算设置。'],
])
let snapshot
let base = newSource
let baseRevision = 0
let busy = false
let stale = false
let needsReview = false
let tested

function gateway(value) {
  if (!/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(value)) return ''
  try { return new URL(value).href } catch { return '' }
}

function draft() {
  return { name: fields.name.value.trim(), gatewayUrl: fields.gatewayUrl.value.trim(), enabled: fields.enabled.checked, key: fields.key.value.trim() }
}

function hasChanges(value = draft()) {
  return Boolean(value.key) || value.name !== base.name || value.enabled !== base.enabled
    || (gateway(value.gatewayUrl) || value.gatewayUrl) !== base.gatewayUrl
}

function selected() {
  return snapshot?.sources.find(source => source.id === base.id)
}

function conflict() {
  return Boolean(snapshot && (baseRevision !== snapshot.revision || needsReview))
}

function readSnapshot(value) {
  if (!Number.isSafeInteger(value?.revision) || value.revision < 0 || !Array.isArray(value.sources)) throw new Error()
  const sources = value.sources.map(source => {
    const { id, name, gatewayUrl, enabled, credentialConfigured } = source
    if (typeof id !== 'string' || typeof name !== 'string' || typeof gatewayUrl !== 'string'
      || typeof enabled !== 'boolean' || typeof credentialConfigured !== 'boolean') throw new Error()
    return { id, name, gatewayUrl, enabled, credentialConfigured }
  })
  return { revision: value.revision, sources }
}

async function callSource(suffix = '', body) {
  if (typeof adminToken !== 'string' || !/^[0-9a-f]{64}$/.test(adminToken)) throw new Error()
  const headers = { 'X-Magpie-Usage-Admin': adminToken }
  if (body) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${sourcesPath}${suffix}`, {
    headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store', credentials: 'omit', redirect: 'error',
    signal: AbortSignal.timeout(suffix === '/test' ? 125_000 : 10_000),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error('source_request_failed', { cause: { status: response.status, code: payload?.error?.code } })
  }
  return response.json()
}

function controls() {
  const value = draft()
  const changed = hasChanges(value)
  const keyNeeded = !base.credentialConfigured || gateway(value.gatewayUrl) !== base.gatewayUrl
  const connectionChanged = keyNeeded || Boolean(value.key)
  const blocked = busy || stale || !snapshot || conflict()
  const latest = selected()
  byId('refresh-sources').disabled = busy
  byId('source-fields').disabled = busy || !snapshot
  byId('sources-section').setAttribute('aria-busy', String(busy))
  form.setAttribute('aria-busy', String(busy))
  fields.key.required = keyNeeded
  byId('source-key-hint').textContent = keyNeeded ? '填写此地址的只读 Key，并测试连接后保存。'
    : value.key ? '测试连接后即可保存替换的 Key。' : '已配置。留空沿用，输入新 Key 可轮换。'
  testButton.disabled = blocked
  const passed = tested?.gatewayUrl === gateway(value.gatewayUrl) && tested.key === value.key
  saveButton.disabled = blocked || !changed || (connectionChanged && !passed)
  const reset = byId('reset-source')
  reset.hidden = !base.id && !changed
  reset.textContent = base.id ? '返回添加来源' : '清空草稿'
  byId('revision-review').hidden = stale || !conflict()
  byId('review-latest').disabled = busy || Boolean(base.id && !latest)
  byId('latest-source').textContent = latest
    ? `当前已保存为「${latest.name}」，地址 ${latest.gatewayUrl}，查询${latest.enabled ? '已启用' : '已停用'}。`
    : base.id ? '当前来源已不存在。可返回添加来源。' : '来源列表已更新，请核对后继续。'
}

function showEditor(source = newSource) {
  base = source
  baseRevision = snapshot.revision
  tested = undefined
  needsReview = false
  byId('source-title').textContent = source.id ? `编辑来源 · ${source.name}` : '添加来源'
  fields.name.value = source.name
  fields.gatewayUrl.value = source.gatewayUrl
  fields.enabled.checked = source.enabled
  fields.key.value = ''
  notice.textContent = ''
  controls()
}

function rowFor(source) {
  const row = document.createElement('tr')
  const title = document.createElement('th')
  title.scope = 'row'
  title.textContent = source.name
  row.append(title)
  for (const value of [source.gatewayUrl, source.enabled ? '已启用' : '已停用', source.credentialConfigured ? '已配置' : '待配置']) {
    const cell = document.createElement('td')
    cell.textContent = value
    row.append(cell)
  }
  const actions = document.createElement('td')
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '编辑'
  button.setAttribute('aria-label', `编辑 ${source.name}`)
  button.addEventListener('click', () => {
    if (busy) return
    if (source.id !== base.id) {
      if (hasChanges()) {
        notice.textContent = '请保存当前草稿，或清空后再切换来源。'
        return
      }
      showEditor(source)
    }
    fields.name.focus()
  })
  actions.append(button)
  row.append(actions)
  return row
}

function present(next) {
  const edited = snapshot && (hasChanges() || needsReview)
  snapshot = next
  if (!edited) showEditor(selected())
  byId('sources-rows').replaceChildren(...next.sources.map(rowFor))
  byId('sources-table').hidden = !next.sources.length
  byId('sources-empty').hidden = next.sources.length > 0
  controls()
}

async function loadSources() {
  const next = readSnapshot(await callSource())
  stale = false
  present(next)
  byId('sources-notice').textContent = ''
}

async function refresh() {
  if (busy) return
  busy = true
  controls()
  byId('sources-notice').textContent = '正在读取来源…'
  try {
    await loadSources()
  } catch (error) {
    byId('sources-notice').textContent = error?.cause?.status === 403
      ? '管理会话已失效。请从用量看板重新打开来源管理。'
      : snapshot ? '刷新失败。当前显示上次读取的来源，可重试。' : '暂时无法读取来源。请刷新重试。'
  } finally {
    busy = false
    controls()
  }
}

function readDraft() {
  if (!form.reportValidity()) return
  const value = draft()
  const gatewayUrl = gateway(value.gatewayUrl)
  if (!value.name || !gatewayUrl) {
    notice.textContent = value.name ? '请输入有效的 HTTP(S) 网关根地址。' : '请输入来源名称。'
    fields[value.name ? 'gatewayUrl' : 'name'].focus()
    return
  }
  if ((!base.credentialConfigured || base.gatewayUrl !== gatewayUrl) && !value.key) {
    notice.textContent = '请输入此网关的专用只读 Key。'
    fields.key.focus()
    return
  }
  return { ...(base.id ? { id: base.id } : {}), revision: baseRevision, name: value.name, gatewayUrl, enabled: value.enabled,
    ...(value.key ? { key: value.key } : {}),
  }
}

async function submit(isTest) {
  if (busy || (isTest ? testButton.disabled : saveButton.disabled)) return
  const body = readDraft()
  if (!body) return
  if (!isTest && (body.key || !base.credentialConfigured || body.gatewayUrl !== base.gatewayUrl)
    && (body.gatewayUrl !== tested?.gatewayUrl || (body.key ?? '') !== tested.key)) {
    notice.textContent = '请先测试当前地址与 Key。'
    controls()
    return
  }
  if (isTest) tested = undefined
  busy = true
  controls()
  notice.textContent = isTest ? '正在测试连接…' : '正在保存来源…'
  try {
    if (isTest) {
      const result = await callSource('/test', body)
      if (result?.status === 'ok') tested = { gatewayUrl: body.gatewayUrl, key: body.key ?? '' }
      notice.textContent = tested ? '连接成功。' : `测试未通过。${failures.get(result?.failure?.code) ?? '请核对网关地址和 Key。'}`
    } else {
      const next = readSnapshot(await callSource('', body))
      if (next.revision <= baseRevision) throw new Error()
      present(next)
      showEditor(body.id ? selected() : undefined)
      notice.textContent = '来源已保存。'
    }
  } catch (error) {
    const status = error?.cause?.status
    const code = error?.cause?.code
    if (status === 409 || status === 404) {
      stale = true
      needsReview = true
      try { await loadSources() } catch {}
      notice.textContent = stale ? '来源配置已变化。请刷新后核对，草稿已保留。'
        : '来源配置已变化。请核对最新修订，草稿已保留。'
    } else if (status === 403) {
      notice.textContent = '管理会话已失效。请从用量看板重新打开来源管理。'
    } else if (status === 400) {
      notice.textContent = code === 'key_required' ? '请重新输入此网关的专用只读 Key。'
        : '请核对来源名称、网关地址及 Key。草稿已保留。'
    } else if (isTest || code === 'source_save_failed') {
      notice.textContent = isTest ? '测试暂时无法完成，请重试。' : '保存失败。草稿已保留，可重试。'
    } else {
      stale = true
      needsReview = true
      notice.textContent = '保存结果待确认。请刷新列表并核对，草稿已保留。'
    }
  } finally {
    busy = false
    controls()
  }
}

function dispatchSubmit(event) {
  event.preventDefault()
  if (!saveButton.disabled) form.dispatchEvent(new Event('submit', { cancelable: true }))
}

byId('refresh-sources').addEventListener('click', refresh)
testButton.addEventListener('click', () => void submit(true))
saveButton.addEventListener('click', dispatchSubmit)
form.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing && event.target.tagName === 'INPUT'
    && event.target.type !== 'checkbox') dispatchSubmit(event)
})
form.addEventListener('submit', event => {
  event.preventDefault()
  void submit(false)
})
for (const field of Object.values(fields)) {
  field.addEventListener('input', () => {
    if (field === fields.gatewayUrl || field === fields.key) {
      tested = undefined
      if (!conflict() && !stale) notice.textContent = ''
    }
    controls()
  })
}
byId('reset-source').addEventListener('click', () => {
  if (busy || !snapshot) return
  showEditor()
  fields.name.focus()
})
byId('review-latest').addEventListener('click', () => {
  if (busy || stale || !conflict() || byId('review-latest').disabled) return
  const value = draft()
  const keepName = value.name !== base.name
  const keepGateway = Boolean(value.key) || (gateway(value.gatewayUrl) || value.gatewayUrl) !== base.gatewayUrl
  const keepEnabled = value.enabled !== base.enabled
  showEditor(selected())
  if (keepName) fields.name.value = value.name
  if (keepGateway) fields.gatewayUrl.value = value.gatewayUrl
  if (keepEnabled) fields.enabled.checked = value.enabled
  fields.key.value = value.key
  notice.textContent = '已载入最新修订。请核对草稿。'
  controls()
  fields.name.focus()
})
void refresh()
