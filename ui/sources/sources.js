const byId = id => document.getElementById(id)
const adminToken = document.querySelector('meta[name="usage-admin-token"]')?.content
const form = byId('source-form')
const rotationForm = byId('rotation-form')
const notice = byId('source-notice')
const fields = {
  name: byId('source-name'), enabled: byId('source-enabled'), digest: byId('source-digest'), rotation: byId('rotation-digest'),
}
const newSource = { name: '', enabled: true }
const recoveryText = new Map([
  ['cursor_expired', '原生游标已过期'], ['cursor_reset', '原生游标已重置'],
  ['cursor_filter_changed', '原生读取范围已变更'], ['cursor_invalid', '原生游标无效'],
])
const failures = new Map([
  ['invalid_source', '请核对来源设置。草稿已保留。'],
  ['credential_in_use', '该摘要已登记。请为此来源生成不同的令牌。'],
  ['pending_key_exists', '已有待用令牌。请刷新并核对上报状态。'],
  ['pending_key_unverified', '请先用待用令牌成功上报用量，再撤销当前令牌。'],
  ['source_rebuild_not_required', '来源的重建状态已变化。请刷新后核对。'],
  ['source_save_failed', '操作失败。草稿已保留，可重试。'],
])
const successText = { create: '来源已登记。', update: '来源已保存。', rotate: '新令牌已登记。',
  revoke: '令牌已撤销。', rebuild: '已确认重建。来源会从可读历史开始同步。',
}
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })
let snapshot
let base = newSource
let baseRevision = ''
let busy = false
let stale = false
let needsReview = false
let managementExpired = false
let confirmation
let discardPending = false
let returnId = ''
const sourceButtons = new Map()
const receiver = createReceiverWizard(byId, controls, () => window.location.replace(managementAddress()))
const back = window.usageHubHost.backSearch()
const navigation = back ? `?back=${encodeURIComponent(back)}` : ''
const reentry = new URLSearchParams({ to: 'sources' })
if (back) reentry.set('back', back)
byId('back-dashboard').href = `../dashboard/${back}`
byId('settings-link').href = `../../../settings.html${navigation}`
byId('status-link').href = `../status/${navigation}`
byId('local-source-hint').href = byId('settings-link').href

function setSourceAddress(id = '') {
  const { pathname, search } = window.location
  window.history.replaceState(null, '', `${pathname}${search}${id ? `#source=${id}` : ''}`)
}

function draft() {
  const name = fields.name.value.trim()
  return { ...(name !== base.name ? { name } : {}),
    ...(fields.enabled.checked !== base.enabled ? { enabled: fields.enabled.checked } : {}),
    ...(!base.id && fields.digest.value ? { digest: fields.digest.value } : {}),
    ...(fields.rotation.value ? { rotation: fields.rotation.value } : {}),
  }
}

function restore(values) {
  for (const [field, value] of Object.entries(values)) {
    if (field === 'enabled') fields.enabled.checked = value
    else fields[field].value = value
  }
}

function selected() {
  return snapshot?.sources.find(source => source.id === base.id)
}

function conflict() {
  return Boolean(snapshot && (baseRevision !== snapshot.revision || needsReview))
}

function readSnapshot(value) {
  if (!usageHubOptions.revision(value?.revision) || !Array.isArray(value.sources)) throw new Error()
  for (const source of value.sources) {
    if ((source?.id !== 'local' && !usageHubOptions.revision(source?.id)) || typeof source.name !== 'string' || typeof source.enabled !== 'boolean'
      || !['local', 'legacy', 'otlp'].includes(source.transport) || typeof source.credentials?.current !== 'boolean'
      || typeof source.credentials.pending !== 'boolean' || typeof source.credentials.pendingVerified !== 'boolean') throw new Error()
  }
  return value
}

async function callSource(body) {
  if (!/^[0-9a-f]{64}$/.test(adminToken ?? '')) throw new Error()
  const headers = { 'X-Magpie-Usage-Admin': adminToken }
  if (body) headers['Content-Type'] = 'application/json'
  const response = await fetch('../api/sources', {
    headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error('source_request_failed', { cause: { status: response.status, code: payload?.error?.code } })
  }
  return readSnapshot(await response.json())
}

function credentialLabel(source) {
  if (source.transport !== 'otlp') return '—'
  const { current, pending, pendingVerified } = source.credentials
  if (pending) return pendingVerified ? '已收到新令牌上报，可撤销原令牌' : '等待新令牌上报用量'
  return current ? '已登记' : '待登记'
}

function rebuildAllowed(source) {
  return source?.transport === 'local' && (source.rebuildAllowed ?? source.phase === 'recovery_required')
}

function canConnect(source) {
  return source?.transport === 'otlp' && source.enabled && (source.credentials.current || source.credentials.pending)
}

function controls() {
  const latest = selected()
  const local = latest?.transport === 'local'
  const historical = latest?.transport === 'legacy'
  const otlp = latest?.transport === 'otlp'
  const wizard = receiver.active
  const editable = !base.id || otlp
  const waiting = busy || receiver.busy
  const blocked = waiting || stale || !snapshot || conflict() || discardPending
  const editing = Boolean(base.id)
  const inEditor = wizard || editing
  const { name, enabled, digest, rotation } = draft()
  const credential = latest?.credentials

  byId('editor').hidden = !inEditor
  byId('sources-section').hidden = inEditor
  byId('back-dashboard').hidden = inEditor
  byId('config-nav').hidden = inEditor
  byId('leave-confirmation').hidden = !discardPending
  byId('add-source').disabled = waiting || !snapshot
  byId('refresh-sources').disabled = waiting
  byId('refresh-editor').disabled = waiting || discardPending
  byId('refresh-receipt').disabled = waiting
  byId('management-reentry').hidden = !managementExpired
  if (managementExpired) byId('resume-management').href = managementAddress()
  byId('sources-section').setAttribute('aria-busy', String(waiting))
  form.hidden = !editable || receiver.completed
  form.setAttribute('aria-busy', String(waiting))
  byId('source-fields').disabled = waiting || !snapshot || !editable || discardPending
  byId('name-field').hidden = editing && wizard
  byId('enabled-field').hidden = wizard
  byId('create-credential').hidden = editing
  byId('token-guide').hidden = editing || !wizard
  byId('save-source').disabled = blocked || Boolean(confirmation) || !editable
    || (wizard ? receiver.blocked || receiver.completed : name === undefined && enabled === undefined && !digest)
  byId('save-source').textContent = wizard ? editing ? '确认中心接收设置' : '登记设备并连接中心' : '保存来源'
  byId('source-identity').hidden = !latest || local
  byId('source-id').textContent = latest && !local ? latest.id : ''
  byId('local-source-hint').hidden = !local
  byId('historical-source-hint').hidden = !historical
  if (historical) {
    const search = new URLSearchParams(back)
    search.set('sourceId', latest.id)
    search.set('view', 'overview')
    byId('historical-source-hint').href = `../dashboard/${usageHubOptions.dashboardSearch(`?${search}`)}`
  }
  byId('source-overview').hidden = !latest || wizard
  byId('source-form-title').textContent = wizard ? editing ? '确认中心接收设置' : '登记来源' : '基本信息'
  byId('source-credentials').hidden = !otlp || wizard
  byId('source-connection').hidden = !otlp || wizard
  byId('connection-state').hidden = !otlp || canConnect(latest)
  byId('resume-source').hidden = wizard || !canConnect(latest)
  byId('resume-source').disabled = blocked || Boolean(confirmation)
  byId('credential-status').textContent = otlp ? credentialLabel(latest) : ''
  rotationForm.hidden = Boolean(credential?.pending && !rotation)
  fields.rotation.disabled = busy || discardPending
  byId('rotate-source').textContent = credential?.current ? '登记新令牌' : '登记令牌'
  byId('rotate-source').disabled = blocked || Boolean(confirmation) || !otlp || Boolean(credential?.pending) || !rotation
  byId('revoke-current').hidden = !otlp || !credential?.current
  byId('revoke-current').disabled = blocked || Boolean(confirmation) || Boolean(credential?.pending && !credential.pendingVerified)
  byId('revoke-pending').hidden = !otlp || !credential?.pending
  byId('revoke-all').hidden = !otlp || !credential?.current || !credential?.pending
  byId('revoke-pending').disabled = blocked || Boolean(confirmation)
  byId('revoke-all').disabled = blocked || Boolean(confirmation)
  byId('recovery-tools').hidden = !rebuildAllowed(latest)
  byId('rebuild-source').disabled = blocked || Boolean(confirmation)
  byId('action-confirmation').hidden = !confirmation
  byId('confirm-action').disabled = blocked
  byId('cancel-action').disabled = busy
  byId('reset-source').hidden = !inEditor
  byId('reset-source').disabled = waiting || discardPending
  byId('revision-review').hidden = stale || !conflict()
  byId('review-latest').disabled = busy || Boolean(editing && !latest)
  byId('latest-source').textContent = latest
    ? `当前已保存为「${latest.name}」，${sourceStatus(latest)}。${otlp ? `${credentialLabel(latest)}。` : ''}`
    : editing ? '当前来源已不存在。请返回来源列表。' : '来源列表已更新，请核对后继续。'
  const receipt = formatTime(latest?.lastPageAt)
  byId('first-receipt').textContent = receiver.completed
    ? receipt ? `已收到用量。最近接收 ${receipt}。` : '等待首次上报。' : ''
  receiver.render(busy)
}

function showEditor(source = newSource) {
  base = source
  baseRevision = snapshot.revision
  needsReview = false
  confirmation = undefined
  byId('source-title').textContent = receiver.active ? source.id ? `设备接入 · ${source.name}` : '添加设备' : !source.id ? '添加设备'
    : source.transport === 'otlp' ? `编辑来源 · ${source.name}` : source.name
  restore({ name: source.name, enabled: source.enabled, digest: '', rotation: '' })
  notice.textContent = ''
  byId('credential-notice').textContent = ''
  byId('source-facts').replaceChildren(...sourceFacts(base.id ? source : undefined))
}

function appendCell(row, value, className) {
  const element = document.createElement('span')
  element.className = className
  element.textContent = value
  row.append(element)
  return element
}

function sourceStatus(source) {
  if (source.transport === 'legacy') return '历史来源'
  if (!source.enabled) return '已暂停'
  if (source.transport === 'otlp') return formatTime(source.lastPageAt) ? '已收到用量' : '等待首次上报'
  if (source.phase === 'recovery_required') return '待确认重建'
  if (source.phase === 'rebuilding') return '重建中'
  if (!source.lastSeenAt) return '等待首次采集'
  if (Date.now() - Date.parse(source.lastSeenAt) > 180_000) return '暂失联'
  if (source.phase === 'backfill') return '正在回填历史'
  return source.hasMore ? '追赶中' : '已同步'
}

function formatTime(value) {
  if (typeof value !== 'string') return ''
  const time = Date.parse(value)
  return Number.isFinite(time) ? dateTime.format(time) : ''
}

function rowFor(source) {
  const row = document.createElement('li')
  row.className = 'source-list-row'
  appendCell(row, source.name, 'source-list-name')
  appendCell(row, sourceStatus(source), 'source-list-status')
  appendCell(row, formatTime(source.transport === 'otlp' ? source.lastPageAt : source.lastSeenAt) || '暂无活动', 'source-list-time')
  const actions = appendCell(row, '', 'source-list-action')
  const button = document.createElement('button')
  button.className = 'quiet'
  button.type = 'button'
  button.textContent = source.transport === 'otlp' ? '编辑' : '查看'
  button.setAttribute('aria-label', `${button.textContent} ${source.name}`)
  button.addEventListener('click', () => {
    if (busy || receiver.busy) return
    returnId = source.id
    setSourceAddress(source.id)
    showEditor(source)
    controls()
    byId('source-title').focus()
  })
  actions.append(button)
  sourceButtons.set(source.id, button)
  return row
}

function sourceFacts(source) {
  if (!source) return []
  const entries = [['状态', sourceStatus(source)]]
  if (source.transport === 'otlp') entries.push(['最近接收', formatTime(source.lastPageAt) || '暂无'])
  if (source.transport === 'local') {
    entries.push(['最近活动', formatTime(source.lastSeenAt) || '暂无'], ['最近完成', formatTime(source.lastSyncedAt) || '暂无'],
      ['最近确认页', formatTime(source.lastPageAt) || '暂无'])
    const reason = recoveryText.get(source.recoveryReason)
    if (reason) entries.push(['恢复原因', reason])
    if (source.gap?.missingRows > 0) entries.push(['上次重建缺口', `${source.gap.missingRows.toLocaleString('zh-CN')} 条旧记录`])
  }
  return entries.flatMap(([label, value]) => ['dt', 'dd'].map((tag, index) => {
    const field = document.createElement(tag)
    field.textContent = index ? value : label
    return field
  }))
}

function present(next) {
  snapshot = next
  sourceButtons.clear()
  byId('sources-rows').replaceChildren(...next.sources.map(rowFor))
  byId('sources-rows').hidden = !next.sources.length
  byId('sources-empty').hidden = next.sources.length > 0
  byId('source-facts').replaceChildren(...sourceFacts(selected()))
}

async function loadSources() {
  const next = await callSource()
  const first = !snapshot
  const restored = receiver.resume()
  const preserve = needsReview || Boolean(snapshot && Object.keys(draft()).length)
  stale = false
  managementExpired = false
  present(next)
  const awaiting = restored.id && restored.params.get('stage') === 'register'
  const recovered = awaiting && next.sources.find(source => source.id === restored.id && source.transport === 'otlp')
  if (recovered) {
    if (!receiver.active) receiver.open(recovered.id, restored.params)
    receiver.registered(recovered.id)
    showEditor(recovered)
    if (!canConnect(recovered)) {
      receiver.close()
      showEditor(recovered)
      notice.textContent = '请先启用来源并登记上报凭据。'
    } else notice.textContent = '已确认原设备登记成功。请继续核对中心接收设置。'
    byId('sources-notice').textContent = ''
    return
  }
  if (receiver.active && base.id && !canConnect(selected())) {
    receiver.close()
    showEditor(selected())
    byId('sources-notice').textContent = '原设备的来源状态已变更。请核对登记和凭据状态。'
    return
  }
  if (!preserve) {
    if (first && restored.open) {
      const source = restored.id && snapshot.sources.find(item => item.id === restored.id && item.transport === 'otlp')
      if (source && !canConnect(source)) {
        showEditor(source)
        notice.textContent = '请先启用来源并登记上报凭据。'
      } else if (source || !restored.id || awaiting) {
        if (source) returnId = source.id
        receiver.open(restored.id, restored.params, Boolean(awaiting))
        showEditor(source || newSource)
        if (awaiting) notice.textContent = '最新列表中未查到此次登记。请重新填写名称和摘要，再手动提交。'
        controls()
        byId('source-title').focus()
      } else {
        showEditor()
        byId('sources-notice').textContent = '已登记的来源不存在。请核对来源列表。'
        return
      }
    } else if (first && usageHubOptions.sourceFragment(window.location.hash).startsWith('#source=')) {
      returnId = new URLSearchParams(window.location.hash.slice(1)).get('source')
      const source = next.sources.find(item => item.id === returnId)
      showEditor(source)
      if (!source) {
        setSourceAddress()
        byId('sources-notice').textContent = '此来源已不可用，请核对来源列表。'
        return
      }
      controls()
      byId('source-title').focus()
    } else showEditor(selected())
  }
  byId('sources-notice').textContent = ''
}

function managementAddress() {
  return `../?${reentry}${usageHubOptions.sourceFragment(window.location.hash)}`
}

function expireManagement() {
  stale = true
  managementExpired = true
  byId('sources-notice').textContent = '管理会话已失效。请重新打开来源管理。'
}

async function reconcileSources() {
  try { await loadSources() } catch (error) {
    if (error?.cause?.status === 403) expireManagement()
  }
}

async function refresh() {
  if (busy || receiver.busy) return
  confirmation = undefined
  busy = true
  controls()
  byId('sources-notice').textContent = '正在读取来源…'
  try {
    await loadSources()
  } catch (error) {
    if (error?.cause?.status === 403) expireManagement()
    else byId('sources-notice').textContent = snapshot ? '刷新失败。当前显示上次读取的来源，可重试。' : '暂时无法读取来源。请刷新重试。'
  } finally {
    busy = false
    controls()
  }
}

async function mutate(body, receiverPatch) {
  if (busy || stale || !snapshot || conflict()) return
  const notice = ['rotate', 'revoke'].includes(body.action) ? byId('credential-notice') : byId('source-notice')
  const previousDraft = draft()
  confirmation = undefined
  busy = true
  controls()
  notice.textContent = '正在提交来源变更…'
  try {
    const next = await callSource({ ...body, revision: baseRevision })
    const source = next.sources.find(item => item.id === body.id)
    if (next.revision === baseRevision || !source || (body.action === 'create' && source.transport !== 'otlp')) throw new Error()
    present(next)
    if (body.action === 'create') receiver.registered(source.id)
    showEditor(source)
    const { rotation, ...settings } = previousDraft
    if (body.action !== 'create' && body.action !== 'update') restore(settings)
    if (rotation && body.action !== 'rotate') restore({ rotation })
    notice.textContent = successText[body.action]
    byId('source-title').focus()
    if (receiverPatch) await receiver.finish(source.id, receiverPatch)
  } catch (error) {
    const { status, code } = error?.cause ?? {}
    if (code === 'source_revision_conflict' || code === 'source_not_found' || code === 'source_id_in_use') {
      stale = true
      needsReview = true
      await reconcileSources()
      if (body.action === 'create' && !stale && base.id === body.id) return
      notice.textContent = stale ? '来源配置已变化。请刷新后核对，草稿已保留。'
        : '来源配置已变化。请核对最新修订，草稿已保留。'
    } else if (status === 403) {
      expireManagement()
      notice.textContent = '请使用页面顶部的链接重新打开来源管理。'
    } else if (failures.has(code)) {
      notice.textContent = failures.get(code)
    } else {
      stale = true
      needsReview = true
      notice.textContent = '提交结果待确认。请刷新列表并核对，草稿已保留。'
      if (body.action === 'create') {
        await reconcileSources()
        if (!stale && !base.id) notice.textContent = '尚未查到此次登记。请核对最新来源列表后再手动提交。'
      }
    }
  } finally {
    busy = false
    controls()
  }
}

function digestFrom(field, feedback = notice) {
  const value = field.value.trim()
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  feedback.textContent = '请填写 64 位十六进制的令牌摘要。'
  field.focus()
}

function confirm(body, text, trigger) {
  if (trigger.disabled || trigger.hidden) return
  confirmation = { body, trigger }
  byId('confirmation-text').textContent = text
  controls()
  byId('cancel-action').focus()
}

function bindSubmit(target, button, submit) {
  function dispatch(event) {
    event.preventDefault()
    if (!button.disabled) target.dispatchEvent(new Event('submit', { cancelable: true }))
  }
  button.addEventListener('click', dispatch)
  target.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && event.target.tagName === 'INPUT'
      && event.target.type !== 'checkbox') dispatch(event)
  })
  target.addEventListener('submit', event => {
    event.preventDefault()
    if (!button.disabled) submit()
  })
}

byId('refresh-sources').addEventListener('click', refresh)
byId('refresh-editor').addEventListener('click', refresh)
byId('refresh-receipt').addEventListener('click', refresh)
bindSubmit(form, byId('save-source'), () => {
  const name = fields.name.value.trim()
  if (!name || [...name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    notice.textContent = '请填写 1 至 80 个字符的有效来源名称。'
    fields.name.focus()
    return
  }
  const enabled = fields.enabled.checked
  if (receiver.active) {
    const digest = base.id ? undefined : digestFrom(fields.digest)
    if (!base.id && !digest) return
    const patch = receiver.validate()
    if (!patch) return
    if (base.id) void receiver.finish(base.id, patch)
    else void mutate({ action: 'create', id: receiver.beginRegistration(), name, digest, enabled: true }, patch)
  } else if (base.id) {
    const values = draft()
    void mutate({ action: 'update', id: base.id, ...(values.name === undefined ? {} : { name }),
      ...(values.enabled === undefined ? {} : { enabled }) })
  }
})
bindSubmit(rotationForm, byId('rotate-source'), () => {
  const digest = digestFrom(fields.rotation, byId('credential-notice'))
  if (digest) void mutate({ action: 'rotate', id: base.id, digest })
})
for (const slot of ['current', 'pending', 'all']) {
  const trigger = byId(`revoke-${slot}`)
  trigger.addEventListener('click', () => {
    const source = selected()
    if (source?.transport !== 'otlp') return
    const result = slot === 'current' && source.credentials.pendingVerified ? '待用令牌将接替当前令牌。'
      : slot === 'pending' ? '待用令牌将无法使用。' : '请在来源更新令牌后恢复上报。'
    confirm({ action: 'revoke', id: source.id, slot }, `确认对「${source.name}」执行“${trigger.textContent}”？${result}`, trigger)
  })
}
byId('rebuild-source').addEventListener('click', () => {
  const source = selected()
  if (!rebuildAllowed(source)) return
  confirm({ action: 'rebuild', id: source.id },
    `确认「${source.name}」仍是原来源？重建将从本机可读历史回填，完成后切换看板数据。`, byId('rebuild-source'))
})
byId('cancel-action').addEventListener('click', () => {
  const trigger = confirmation?.trigger
  confirmation = undefined
  controls()
  trigger?.focus()
})
byId('confirm-action').addEventListener('click', () => {
  if (confirmation && !byId('confirm-action').disabled) void mutate(confirmation.body)
})
for (const field of Object.values(fields)) field.addEventListener('input', controls)
function startWizard(source) {
  if (busy || receiver.busy || !snapshot) return
  if (Object.keys(draft()).length || receiver.active && !receiver.completed) {
    notice.textContent = '请先完成当前操作，或点「返回来源列表」放弃草稿。'
    return
  }
  receiver.open(source?.id)
  showEditor(source)
  controls()
  byId('source-title').focus()
}
byId('add-source').addEventListener('click', () => { returnId = ''; startWizard() })
byId('resume-source').addEventListener('click', () => {
  if (!byId('resume-source').hidden && !byId('resume-source').disabled) startWizard(selected())
})
function returnToSources() {
  if (busy || receiver.busy || !snapshot) return
  discardPending = false
  receiver.close()
  setSourceAddress()
  showEditor()
  controls()
  const trigger = sourceButtons.get(returnId) || byId('add-source')
  trigger.focus()
  returnId = ''
}
byId('reset-source').addEventListener('click', () => {
  if (busy || receiver.busy || !snapshot) return
  if (!Object.keys(draft()).length && !receiver.dirty) { returnToSources(); return }
  discardPending = true
  controls()
  byId('keep-editing').focus()
})
byId('discard-source').addEventListener('click', returnToSources)
byId('keep-editing').addEventListener('click', () => {
  discardPending = false
  controls()
  byId('reset-source').focus()
})
byId('review-latest').addEventListener('click', () => {
  if (busy || stale || !conflict() || byId('review-latest').disabled) return
  const previousDraft = draft()
  const source = selected()
  showEditor(source)
  restore(previousDraft)
  notice.textContent = '已载入最新修订。请核对草稿。'
  controls()
  if (source && (receiver.active || source.transport !== 'otlp')) byId('source-title').focus()
  else fields.name.focus()
})
void refresh()
