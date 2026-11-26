(() => {
  const options = usageHubOptions
  const element = id => document.getElementById(id)
  const readTimeoutMs = 12_000
  const inputs = Object.fromEntries(Object.keys(options.settingsView({})).map(name => [name, element(name)]))
  const settingsMessage = element('settings-message')
  const recoveryMessage = element('recovery-message')
  const recoveryKind = element('recovery-kind')
  const recoveryFrom = element('recovery-from')
  const recoveryTo = element('recovery-to')
  const confirmation = element('confirmation')
  let saved
  let snapshot
  let confirmationAction
  let dirtyFields = new Set()

  const failures = {
    read_failed: '暂时无法读取设置。请重试，页面仍无法连接时请重新打开插件页。',
    preflight_failed: '提交前无法读取最新设置。草稿已保留，请重试。',
    write_failed: '提交失败。草稿已保留，请重试。',
    readback_failed: '提交结果待确认。请重新读取设置。',
    readback_mismatch: '读回值与本次提交不一致。请核对更新项，草稿已保留。',
    conflict: '其他会话已更新设置。请核对更新项，草稿已保留。',
  }

  function readOptions() {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('bridge_timeout')), readTimeoutMs)
    })
    const request = Promise.resolve().then(async () => {
      await window.magpie.ready
      return window.magpie.options.get()
    })
    return Promise.race([timeout, request]).finally(() => clearTimeout(timer))
  }

  function message(target, text, alert = false) {
    target.textContent = text
    target.toggleAttribute('data-alert', alert)
  }

  function inputValue(name) {
    return name === 'enabled' ? inputs[name].checked : inputs[name].value
  }

  function readDirtyFields() {
    const baseline = options.settingsView(saved ?? {})
    const fields = new Set(Object.keys(inputs).filter(name => inputValue(name) !== baseline[name]))
    if (fields.has('role') || fields.has('mode')) fields.add('enabled')
    return fields
  }

  function renderSettings(newSaved, reset) {
    saved = newSaved
    for (const [name, value] of Object.entries(options.settingsView(saved))) {
      if (!reset && dirtyFields.has(name)) continue
      if (name === 'enabled') inputs[name].checked = value
      else inputs[name].value = value
    }
    element('key-state').textContent = options.credentialConfigured(saved) ? '已配置' : '待配置'
    element('pairing-code-state').textContent = options.credentialConfigured(saved, 'pairingCodeFile') ? '已配置路径' : ''
    element('ingest-key-state').textContent = options.credentialConfigured(saved, 'ingestKeyFile') ? '已配置' : '可选'
    dirtyFields = readDirtyFields()
  }

  function updateDiagnosticLink() {
    const link = element('diagnostic-link')
    const guide = element('diagnostic-guide')
    const revision = options.revision(saved?.configRevision)
    const center = saved?.role === 'center'
    element('revision-value').textContent = revision
    element('settings-revision').hidden = !revision
    const service = window.magpie?.service
    const href = options.pageServiceLink(service, window.location.href, saved)
    link.hidden = !href
    link.textContent = center ? '打开用量看板' : '打开运行诊断'
    guide.textContent = center ? '在 Magpie Web 的插件页打开中心看板。' : '在 Magpie Web 的插件页打开运行诊断。'
    if (!href) {
      link.removeAttribute('href')
      if (service && center && saved.enabled !== true) guide.textContent = '启用中心并保存后可打开用量看板。'
      if (service && !center && !revision) guide.textContent = '保存设置后可打开运行诊断。'
      return
    }
    link.href = href
    guide.textContent = center ? '在看板查看用量或打开「来源管理」。'
      : saved?.mode === 'managed' ? '在运行诊断核对配对与同步状态。' : '在运行诊断核对后台采用的修订与回填进度。'
  }

  function updateAvailability() {
    const busy = snapshot.writing || snapshot.refreshing
    const saveBlocked = !saved || busy || snapshot.pending || Boolean(snapshot.differences)
    const hasDraft = dirtyFields.size > 0
    const center = inputs.role.value === 'center'
    const managed = inputs.mode.value === 'managed'
    const sourceRecovery = !center && !managed && saved?.role !== 'center' && saved?.mode === 'continuous'
    element('source-settings').hidden = center
    element('source-settings').disabled = center
    element('center-settings').hidden = !center
    element('center-settings').disabled = !center
    element('managed-settings').hidden = !managed
    element('managed-settings').disabled = !managed
    element('manual-settings').hidden = managed
    element('manual-settings').disabled = managed
    element('recovery-panel').hidden = !sourceRecovery
    element('reload-options').disabled = snapshot.writing
    element('settings-fields').disabled = !saved || snapshot.writing || snapshot.pending
    element('save-settings').disabled = saveBlocked
    element('rebase-options').disabled = busy
    element('rebase-options').hidden = !snapshot.differences
    element('settings-form').setAttribute('aria-busy', String(busy))
    element('recovery-form').setAttribute('aria-busy', String(busy))

    const binding = sourceRecovery && saved && options.recoveryBinding(saved)
    const hasRequest = sourceRecovery && Boolean(saved?.recoveryRequest)
    element('submitted-request').hidden = !hasRequest
    element('withdraw-request').disabled = !hasRequest || saveBlocked || hasDraft
    element('recovery-fields').disabled = saveBlocked || hasDraft || !binding
    element('recovery-end-field').hidden = recoveryKind.value !== 'range'
    let hint = ''
    if (!saved) hint = '请先读取同步设置。'
    else if (hasDraft) hint = '请先保存同步设置草稿。'
    else if (snapshot.pending || snapshot.differences) hint = '请先核对已保存的同步设置。'
    else if (!binding) hint = '请先保存并启用完整的同步设置。'
    element('recovery-hint').textContent = hint
    element('submitted-request-text').textContent = hasRequest ? '已有回填请求。受理结果见 Web 诊断。' : ''
  }

  function render(state) {
    snapshot = state
    const { action, result, differences } = state
    if (state.saved && (state.saved !== saved || result === 'confirmed')) {
      renderSettings(state.saved, result === 'confirmed' && action === 'settings')
    }
    updateDiagnosticLink()
    updateAvailability()

    const differenceList = element('options-difference')
    differenceList.hidden = !differences
    differenceList.replaceChildren(...(differences ?? []).map(label => {
      const item = document.createElement('li')
      item.textContent = label
      return item
    }))

    const target = action === 'settings' ? settingsMessage : recoveryMessage
    if (differences) {
      message(settingsMessage, failures[result] ?? failures.conflict, true)
      if (action !== 'settings') message(recoveryMessage, '请先核对同步设置。', true)
      return
    }
    if (Object.hasOwn(failures, result)) {
      message(target, failures[result], true)
      return
    }
    if (result === 'loading') message(target, '正在读取已保存设置…')
    if (result === 'writing') message(target, '正在提交并核对读回值…')
    if (result === 'loaded') message(settingsMessage, dirtyFields.size ? '设置已刷新。草稿已保留。' : '')
    if (result === 'rebased') {
      message(settingsMessage, dirtyFields.size ? '已读取最新设置。请核对保留的草稿。' : '已读取最新设置。')
      message(recoveryMessage, '')
    }
    if (result === 'confirmed') {
      if (action === 'settings') message(settingsMessage, saved.role === 'center' ? '中心设置已保存。'
        : '已保存。后台采用状态见 Web 诊断。')
      if (action === 'recovery') {
        recoveryFrom.value = ''
        recoveryTo.value = ''
        message(recoveryMessage, '回填请求已保存。请在 Web 诊断查看受理与进度。')
      }
      if (action === 'withdraw') message(recoveryMessage, '已撤回待受理请求。')
    }
  }

  const session = options.createSession({
    get: readOptions,
    set: candidate => window.magpie.options.set(candidate),
  }, render)

  function showFieldError(error, target) {
    if (error instanceof options.FieldError) {
      message(target, error.message, true)
      element(error.field)?.focus()
    } else {
      message(target, '暂时无法处理此操作，请重试。', true)
    }
  }

  function bindSubmit(formId, buttonId, handler) {
    const form = element(formId)
    const button = element(buttonId)
    const submit = event => {
      event.preventDefault()
      if (!button.disabled) form.dispatchEvent(new Event('submit', { cancelable: true }))
    }
    button.addEventListener('click', submit)
    form.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing && event.target.tagName === 'INPUT'
        && event.target.type !== 'checkbox') submit(event)
    })
    form.addEventListener('submit', handler)
  }

  function preview(action, changes, rows, title, note, buttonLabel) {
    confirmationAction = { action, changes, saved }
    const fields = element('confirmation-fields')
    fields.replaceChildren(...rows.flatMap(([label, value]) => {
      const term = document.createElement('dt')
      const description = document.createElement('dd')
      term.textContent = label
      description.textContent = value
      return [term, description]
    }))
    fields.hidden = rows.length === 0
    element('confirmation-title').textContent = title
    element('confirmation-note').textContent = note
    element('confirm-action').textContent = buttonLabel
    confirmation.showModal()
  }

  element('reload-options').addEventListener('click', () => void session.refresh())
  element('rebase-options').addEventListener('click', session.adoptLatest)
  for (const input of Object.values(inputs)) {
    const changesRole = input === inputs.role || input === inputs.mode
    input.addEventListener(changesRole ? 'change' : 'input', () => {
      if (changesRole) inputs.enabled.checked = false
      dirtyFields = readDirtyFields()
      updateAvailability()
      if (!snapshot.differences && !snapshot.pending) {
        message(settingsMessage, dirtyFields.size ? '有未保存的更改。' : '')
      }
    })
  }

  bindSubmit('settings-form', 'save-settings', event => {
    event.preventDefault()
    if (element('save-settings').disabled || element('settings-fields').disabled) return
    const draft = Object.fromEntries(Object.keys(inputs).map(name => [name, inputValue(name)]))
    draft.pollIntervalSec = inputs.pollIntervalSec.valueAsNumber
    draft.requestTimeoutSec = inputs.requestTimeoutSec.valueAsNumber
    draft.ingestPort = inputs.ingestPort.valueAsNumber
    try {
      void session.submit('settings', options.settingsPatch(draft, saved))
    } catch (error) {
      showFieldError(error, settingsMessage)
    }
  })

  recoveryKind.addEventListener('change', updateAvailability)
  bindSubmit('recovery-form', 'review-recovery', event => {
    event.preventDefault()
    if (element('recovery-fields').disabled) return
    try {
      const binding = options.recoveryBinding(saved)
      const draft = options.recoveryDraft(binding, recoveryKind.value, recoveryFrom.value, recoveryTo.value)
      const { kind, from, to } = draft
      const isRange = kind === 'range'
      const mode = binding.initialMode === 'now' ? '从现在开始' : '读取可见历史'
      const provider = binding.sourceProviderId ? `，供应商 ID 为 ${binding.sourceProviderId}` : ''
      preview('recovery', { recoveryRequest: draft }, [
        ['本机源网关', binding.sourceGatewayUrl],
        ['原中心', binding.centralGatewayUrl],
        ['筛选条件', `经源网关调用（through），专用测试 Key ID 为 ${binding.sourceCallerKeyId}${provider}，首次起点为「${mode}」`],
        ['起点（含）', from],
        ['截止', to ? `${to}（不含）` : '源端读到的当前进度'],
      ], isRange ? '确认补齐时间段' : '确认恢复失效游标', isRange
        ? '时间按 UTC 显示。回填只覆盖源账本仍可见的记录，结束后从原游标继续同步。'
        : '起点按 UTC 显示。后台先核验原游标已失效，补传可见记录后保存新的日常游标。', '确认并提交')
    } catch (error) {
      showFieldError(error, recoveryMessage)
    }
  })

  element('withdraw-request').addEventListener('click', () => {
    if (element('withdraw-request').disabled) return
    preview('withdraw', {}, [], '撤回待受理请求', '已受理的回填会保留。可通过停用连续同步暂停该任务。', '确认撤回')
  })

  element('confirm-action').addEventListener('click', () => {
    const confirmed = confirmationAction
    confirmationAction = undefined
    confirmation.close()
    if (!confirmed || confirmed.saved !== saved || dirtyFields.size || snapshot.refreshing || snapshot.writing) {
      message(recoveryMessage, '设置已变化，请重新核对后提交。', true)
      return
    }
    const patch = confirmed.action === 'recovery'
      ? { recoveryRequest: { ...confirmed.changes.recoveryRequest, id: options.createId() } }
      : confirmed.changes
    void session.submit(confirmed.action, patch)
  })

  element('cancel-action').addEventListener('click', () => confirmation.close())
  confirmation.addEventListener('close', () => { confirmationAction = undefined })
  void session.refresh()
})()
