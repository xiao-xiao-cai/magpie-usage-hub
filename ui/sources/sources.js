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
let confirmation

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
  if (typeof value?.revision !== 'string' || !value.revision || !Array.isArray(value.sources)) throw new Error()
  for (const source of value.sources) {
    if (typeof source?.id !== 'string' || typeof source.name !== 'string' || typeof source.enabled !== 'boolean'
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

function controls() {
  const latest = selected()
  const local = latest?.transport === 'local'
  const historical = latest?.transport === 'legacy'
  const otlp = latest?.transport === 'otlp'
  const editable = !base.id || otlp
  const blocked = busy || stale || !snapshot || conflict()
  const editing = Boolean(base.id)
  const { name, enabled, digest, rotation } = draft()
  const credential = latest?.credentials

  byId('refresh-sources').disabled = busy
  byId('sources-section').setAttribute('aria-busy', String(busy))
  form.hidden = !editable
  form.setAttribute('aria-busy', String(busy))
  byId('source-fields').disabled = busy || !snapshot || !editable
  byId('create-credential').hidden = editing
  byId('save-source').disabled = blocked || Boolean(confirmation) || !editable
    || (name === undefined && enabled === undefined && !digest)
  byId('source-identity').hidden = !latest || local
  byId('source-id').textContent = latest && !local ? latest.id : ''
  byId('local-source-hint').hidden = !local
  byId('historical-source-hint').hidden = !historical
  byId('source-credentials').hidden = !otlp
  byId('credential-status').textContent = otlp ? credentialLabel(latest) : ''
  rotationForm.hidden = Boolean(credential?.pending && !rotation)
  fields.rotation.disabled = busy
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
  byId('reset-source').hidden = !editing && name === undefined && enabled === undefined && !digest
  byId('reset-source').disabled = busy
  byId('reset-source').textContent = editing ? '返回添加 OTLP 来源' : '清空草稿'
  byId('revision-review').hidden = stale || !conflict()
  byId('review-latest').disabled = busy || Boolean(editing && !latest)
  byId('latest-source').textContent = latest
    ? `当前已保存为「${latest.name}」，${sourceStatus(latest)}。${otlp ? `${credentialLabel(latest)}。` : ''}`
    : editing ? '当前来源已不存在。可返回添加 OTLP 来源。' : '来源列表已更新，请核对后继续。'
}

function showEditor(source = newSource) {
  base = source
  baseRevision = snapshot.revision
  needsReview = false
  confirmation = undefined
  byId('source-title').textContent = !source.id ? '添加 OTLP 来源'
    : source.transport === 'otlp' ? `编辑来源 · ${source.name}` : source.name
  restore({ name: source.name, enabled: source.enabled, digest: '', rotation: '' })
  notice.textContent = ''
}

function appendCell(row, value, title = false) {
  const element = document.createElement(title ? 'th' : 'td')
  if (title) element.scope = 'row'
  element.textContent = value
  row.append(element)
  return element
}

function appendNote(cell, text) {
  const note = document.createElement('span')
  note.className = 'detail-meta'
  note.textContent = text
  cell.append(note)
}

function sourceStatus(source) {
  if (source.transport === 'legacy') return '历史来源'
  if (!source.enabled) return '已暂停'
  if (source.transport === 'otlp') return source.phase === 'receiving' ? '已收到用量' : '等待首次上报'
  if (source.phase === 'recovery_required') return '待确认重建'
  if (source.phase === 'rebuilding') return '重建中'
  if (!source.lastSeenAt) return '等待首次采集'
  if (Date.now() - Date.parse(source.lastSeenAt) > 180_000) return '暂失联'
  if (source.phase === 'backfill') return '正在回填历史'
  return source.hasMore ? '追赶中' : '已同步'
}

function rowFor(source) {
  const row = document.createElement('tr')
  appendCell(row, source.name, true)
  const status = appendCell(row, sourceStatus(source))
  const reason = source.transport === 'local' && recoveryText.get(source.recoveryReason)
  if (reason) appendNote(status, reason)
  if (source.gap?.missingRows > 0) appendNote(status, `上次重建未找到 ${source.gap.missingRows} 条旧记录`)
  if (source.transport === 'otlp') {
    appendCell(row, source.lastPageAt ? `最近接收 ${dateTime.format(Date.parse(source.lastPageAt))}` : '暂无')
  } else {
    const contact = appendCell(row, source.lastSeenAt ? dateTime.format(Date.parse(source.lastSeenAt)) : '暂无')
    if (source.lastSyncedAt) appendNote(contact, `最近完成 ${dateTime.format(Date.parse(source.lastSyncedAt))}`)
    if (source.lastPageAt) appendNote(contact, `最近确认页 ${dateTime.format(Date.parse(source.lastPageAt))}`)
  }
  appendCell(row, credentialLabel(source))
  const actions = appendCell(row, '')
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = source.transport === 'otlp' ? '编辑' : '查看'
  button.setAttribute('aria-label', `${button.textContent} ${source.name}`)
  button.addEventListener('click', () => {
    if (busy) return
    if (source.id !== base.id) {
      if (Object.keys(draft()).length) {
        notice.textContent = '请保存或清空草稿后切换来源。'
        return
      }
      showEditor(source)
      controls()
    }
    if (source.transport === 'otlp') fields.name.focus()
    else byId('source-title').focus()
  })
  actions.append(button)
  return row
}

function present(next) {
  snapshot = next
  byId('sources-rows').replaceChildren(...next.sources.map(rowFor))
  byId('sources-table').hidden = !next.sources.length
  byId('sources-empty').hidden = next.sources.length > 0
}

async function loadSources() {
  const next = await callSource()
  const preserve = needsReview || Boolean(snapshot && Object.keys(draft()).length)
  stale = false
  present(next)
  if (!preserve) showEditor(selected())
  byId('sources-notice').textContent = ''
}

async function refresh() {
  if (busy) return
  confirmation = undefined
  busy = true
  controls()
  byId('sources-notice').textContent = '正在读取来源…'
  try {
    await loadSources()
  } catch (error) {
    if (error?.cause?.status === 403) stale = true
    byId('sources-notice').textContent = error?.cause?.status === 403
      ? '管理会话已失效。请从用量看板重新打开来源管理。'
      : snapshot ? '刷新失败。当前显示上次读取的来源，可重试。' : '暂时无法读取来源。请刷新重试。'
  } finally {
    busy = false
    controls()
  }
}

async function mutate(body) {
  if (busy || stale || !snapshot || conflict()) return
  const previousDraft = draft()
  confirmation = undefined
  busy = true
  controls()
  notice.textContent = '正在提交来源变更…'
  try {
    const next = await callSource({ ...body, revision: baseRevision })
    const source = body.action === 'create' ? next.sources.find(item => !snapshot.sources.some(old => old.id === item.id))
      : next.sources.find(item => item.id === body.id)
    if (next.revision === baseRevision || !source) throw new Error()
    present(next)
    showEditor(source)
    const { rotation, ...settings } = previousDraft
    if (body.action !== 'create' && body.action !== 'update') restore(settings)
    if (rotation && body.action !== 'rotate') restore({ rotation })
    notice.textContent = successText[body.action]
    byId('source-title').focus()
  } catch (error) {
    const { status, code } = error?.cause ?? {}
    if (code === 'source_revision_conflict' || code === 'source_not_found') {
      stale = true
      needsReview = true
      try { await loadSources() } catch {}
      notice.textContent = stale ? '来源配置已变化。请刷新后核对，草稿已保留。'
        : '来源配置已变化。请核对最新修订，草稿已保留。'
    } else if (status === 403) {
      stale = true
      notice.textContent = '管理会话已失效。请从用量看板重新打开来源管理。'
    } else if (failures.has(code)) {
      notice.textContent = failures.get(code)
    } else {
      stale = true
      needsReview = true
      notice.textContent = '提交结果待确认。请刷新列表并核对，草稿已保留。'
    }
  } finally {
    busy = false
    controls()
  }
}

function digestFrom(field) {
  const value = field.value.trim()
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  notice.textContent = '请填写 64 位十六进制的令牌摘要。'
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
bindSubmit(form, byId('save-source'), () => {
  const name = fields.name.value.trim()
  if (!name || [...name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    notice.textContent = '请填写 1 至 80 个字符的有效来源名称。'
    fields.name.focus()
    return
  }
  const enabled = fields.enabled.checked
  if (base.id) {
    const values = draft()
    void mutate({ action: 'update', id: base.id, ...(values.name === undefined ? {} : { name }),
      ...(values.enabled === undefined ? {} : { enabled }) })
  } else {
    const digest = digestFrom(fields.digest)
    if (digest) void mutate({ action: 'create', name, digest, enabled })
  }
})
bindSubmit(rotationForm, byId('rotate-source'), () => {
  const digest = digestFrom(fields.rotation)
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
byId('reset-source').addEventListener('click', () => {
  if (busy || !snapshot) return
  showEditor()
  controls()
  fields.name.focus()
})
byId('review-latest').addEventListener('click', () => {
  if (busy || stale || !conflict() || byId('review-latest').disabled) return
  const previousDraft = draft()
  const source = selected()
  showEditor(source)
  restore(previousDraft)
  notice.textContent = '已载入最新修订。请核对草稿。'
  controls()
  if (source && source.transport !== 'otlp') byId('source-title').focus()
  else fields.name.focus()
})
void refresh()
