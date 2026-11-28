function createReceiverWizard(element, update, renewManagement) {
  const options = usageHubOptions
  const host = window.usageHubHost
  const notice = element('receiver-notice')
  const inputs = { ingestHost: element('receiver-host'), ingestPort: element('receiver-port'), publicEndpoint: element('receiver-endpoint') }
  let session, state, sourceId, active = false, working = false, completed = false, retryBind = false
  let registering = false
  let showFields = false, restoredConflict = false
  let draftFields = new Set()
  let draftRevision = ''
  let checkingReceipt = false

  function resume() {
    const params = new URLSearchParams(options.receiverFragment(window.location.hash).slice(1))
    const id = options.revision(params.get('add'))
    return { open: params.has('add'), id, params }
  }

  function fragment(value) {
    try { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${value}`) }
    catch { try { window.location.replace(value || '#') } catch {} }
  }

  function remember(id) {
    sourceId = id
    const params = new URLSearchParams({ add: id })
    for (const [key, param] of Object.entries({ ingestHost: 'ip', ingestPort: 'port', publicEndpoint: 'endpoint' })) {
      if (draftFields.has(key)) params.set(param, inputs[key].value.trim())
    }
    if (draftRevision) params.set('revision', draftRevision)
    if (registering) params.set('stage', 'register')
    else if (completed) params.set('stage', checkingReceipt ? 'receipt' : 'windows')
    if (retryBind) params.set('retry', 'bind')
    fragment(options.receiverFragment(`#${params}`))
  }

  function applyDefaults(saved) {
    const view = options.settingsView(saved)
    for (const key of Object.keys(inputs)) {
      if (!draftFields.has(key)) inputs[key].value = key === 'ingestHost' && !view.receiverEnabled && !saved.ingestHost ? '' : view[key]
    }
  }

  function open(id = '', restored, pendingRegistration = false) {
    active = true
    completed = false
    checkingReceipt = false
    retryBind = Boolean(id && restored?.get('retry') === 'bind')
    showFields = false
    restoredConflict = false
    sourceId = id
    registering = pendingRegistration
    state = undefined
    draftFields = new Set()
    draftRevision = restored?.get('revision') ?? ''
    for (const [key, param] of Object.entries({ ingestHost: 'ip', ingestPort: 'port', publicEndpoint: 'endpoint' })) {
      inputs[key].value = ''
      if (id && restored?.has(param)) {
        inputs[key].value = restored.get(param)
        draftFields.add(key)
      }
    }
    if (!restored) fragment(id ? `#add=${encodeURIComponent(id)}` : '#add')
    notice.textContent = ''
    element('copy-notice').textContent = ''
    const messages = { loading: '正在读取中心接收设置…', writing: '正在保存并读回中心设置…',
      read_failed: '暂时无法读取中心设置。请重新读取。', preflight_failed: '保存前无法读取最新设置。可重试。',
      write_failed: '接收设置保存失败。请核对草稿后重试。', readback_failed: '保存结果待确认。请重新读取中心设置。',
      readback_mismatch: '接收设置的读回值与提交值不同。', conflict: '其他会话已更新中心设置。',
      rebased: '已载入最新中心设置。请核对接收地址和端口后继续。',
    }
    const current = options.createSession({ get: () => host.getOptions(), set: value => host.setOptions(value) }, next => {
      if (session !== current) return
      state = next
      if (next.saved) applyDefaults(next.saved)
      notice.textContent = messages[next.result] ?? ''
      if (next.differences?.length) notice.textContent += ` 已变更：${next.differences.join('、')}。请核对后继续。`
      if (sourceId && !registering && ['write_failed', 'readback_failed', 'conflict', 'readback_mismatch', 'preflight_failed'].includes(next.result)) {
        notice.textContent = `来源已登记。${notice.textContent}`
      }
      const revision = options.revision(next.saved?.configRevision) || 'initial'
      if (next.result === 'loaded' && restored && draftRevision && draftRevision !== revision) {
        const currentView = options.settingsView(next.saved)
        if ([...draftFields].some(key => String(currentView[key]) !== inputs[key].value)) {
          restoredConflict = true
          notice.textContent = '中断期间中心设置已更新。请核对已保存值和接收草稿后继续。'
        }
      }
      if (next.result === 'loaded') restored = undefined
      if (next.saved && !restoredConflict) draftRevision = revision
      if (next.result === 'confirmed') draftFields.clear()
      if (sourceId && ['loaded', 'confirmed', 'rebased'].includes(next.result)) remember(sourceId)
      update()
    })
    session = current
    const savedStep = restored?.get('stage')
    void current.refresh().then(async () => {
      if (session !== current || state?.result !== 'loaded' || !['windows', 'receipt'].includes(savedStep)) return
      const view = options.settingsView(state.saved)
      const revision = options.revision(state.saved.configRevision)
      const endpoint = options.publicEndpoint(view.publicEndpoint)
      if (!revision || !endpoint || !view.enabled || !view.receiverEnabled || draftFields.size) return
      working = true
      update()
      try {
        await confirmListening(revision, endpoint, savedStep === 'receipt')
      } finally {
        working = false
        update()
      }
    })
  }

  function close() {
    if (active) fragment('')
    active = false
    completed = false
    sourceId = ''
    registering = false
    state = undefined
    session = undefined
    notice.textContent = ''
    element('copy-notice').textContent = ''
  }

  function validate() {
    if (!state?.saved) return
    const endpoint = options.publicEndpoint(inputs.publicEndpoint.value.trim())
    if (!endpoint) {
      notice.textContent = '请填写设备可达的 HTTP(S) 基础地址，使用远程主机名或 IP，并移除凭据、查询和片段。'
      inputs.publicEndpoint.focus()
      return
    }
    try {
      const view = options.settingsView(state.saved)
      const patch = options.settingsPatch({ ...view, enabled: true, receiverEnabled: true, publicEndpoint: endpoint,
        requestTimeoutSec: Number(view.requestTimeoutSec), ingestHost: inputs.ingestHost.value, ingestPort: inputs.ingestPort.valueAsNumber })
      return { role: 'center', collectionMode: 'otlp', enabled: true, receiverEnabled: true,
        ingestHost: patch.ingestHost, ingestPort: patch.ingestPort, publicEndpoint: patch.publicEndpoint }
    } catch (error) {
      notice.textContent = error instanceof options.FieldError ? error.message : '请核对中心接收设置。'
      inputs[error?.field]?.focus()
    }
  }

  async function verify(revision) {
    const request = { cache: 'no-store', credentials: 'omit', redirect: 'error' }
    await fetch('../', { ...request, signal: AbortSignal.timeout(4000) }).catch(() => {})
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 650))
      try {
        const response = await fetch('../api/status', { ...request, signal: AbortSignal.timeout(3000) })
        if (!response.ok) continue
        const status = await response.json()
        if (status?.schema !== 'magpie-usage-hub/status-v1' || status.role !== 'center' || status.loadedRevision !== revision) continue
        if (status.receiver === 'failed') return 'failed'
        if (status.ready === true && status.receiver === 'listening' && status.appliedRevision === revision) return 'ready'
      } catch {}
    }
    return 'pending'
  }

  async function confirmListening(revision, endpoint, receipt = false) {
    notice.textContent = '来源已登记。正在确认中心已采用设置并监听接收端口…'
    const result = await verify(revision)
    retryBind = result === 'failed'
    if (retryBind) showFields = true
    completed = result === 'ready'
    checkingReceipt = completed && receipt
    remember(sourceId)
    if (completed) {
      element('windows-endpoint').textContent = endpoint
      notice.textContent = ''
      update()
      element(checkingReceipt ? 'receipt-title' : 'windows-title').focus()
    } else {
      notice.textContent = retryBind ? '来源已登记，中心监听失败。请检查监听 IP 或端口占用，修改后重试。'
        : '来源已登记，尚未确认中心已采用本次设置并开始监听。可重试或查看运行诊断。'
    }
  }

  async function finish(id, patch) {
    if (working || !session) return
    working = true
    registering = false
    remember(id)
    update()
    try {
      const saved = state.saved
      const view = options.settingsView(saved)
      const matches = view.enabled && view.receiverEnabled && view.ingestHost === patch.ingestHost
        && Number(view.ingestPort) === patch.ingestPort && view.publicEndpoint === patch.publicEndpoint && options.revision(saved.configRevision)
      if (matches && !retryBind) await session.refresh()
      else await session.submit(patch)
      if (!['confirmed', 'loaded'].includes(state.result)) return
      await confirmListening(state.saved.configRevision, patch.publicEndpoint)
      if (completed) renewManagement()
    } finally {
      working = false
      update()
    }
  }

  function render(busy) {
    const blocked = busy || working || state?.writing || state?.refreshing
    const view = state?.saved && options.settingsView(state.saved)
    const latest = state?.latest ? options.settingsView(state.latest) : view
    const savedEndpoint = view?.receiverEnabled && view.publicEndpoint
    const difference = restoredConflict || state?.differences
    const reuse = savedEndpoint && !showFields && !difference && !draftFields.size
    element('receiver-summary').hidden = !active || completed || !(reuse || difference && latest)
    element('saved-receiver').textContent = latest
      ? `已保存设置 · ${latest.ingestHost || '监听 IP 待补充'}（端口 ${latest.ingestPort || '待补充'}） · 设备地址 ${latest.publicEndpoint || '尚未填写'}` : ''
    element('edit-receiver').hidden = !reuse
    element('receiver-fields').hidden = !active || completed || Boolean(reuse)
    element('receiver-fields').disabled = blocked || !state?.saved || state.pending
    element('windows-settings').hidden = !active || !completed || checkingReceipt
    element('receipt-settings').hidden = !active || !completed || !checkingReceipt
    element('onboarding-steps').hidden = !active
    const current = !completed ? 'register' : checkingReceipt ? 'receipt' : 'windows'
    for (const step of ['register', 'windows', 'receipt']) element(`step-${step}`).setAttribute('aria-current', step === current ? 'step' : 'false')
    element('reload-receiver').hidden = !active || !['read_failed', 'readback_failed'].includes(state?.result)
    element('reload-receiver').disabled = blocked
    element('review-receiver').hidden = !active || !difference
    element('review-receiver').disabled = blocked
  }

  element('go-receipt').addEventListener('click', () => {
    if (!completed || working) return
    checkingReceipt = true
    remember(sourceId)
    update()
    element('receipt-title').focus()
  })
  element('go-windows').addEventListener('click', () => {
    if (!completed || working) return
    checkingReceipt = false
    remember(sourceId)
    update()
    element('windows-title').focus()
  })
  element('reload-receiver').addEventListener('click', () => { if (!working) void session?.refresh() })
  element('review-receiver').addEventListener('click', () => {
    if (working) return
    if (restoredConflict) {
      restoredConflict = false
      draftRevision = options.revision(state.saved.configRevision) || 'initial'
      remember(sourceId)
      notice.textContent = '已读取最新设置。请核对接收草稿后继续。'
      update()
    } else session?.adoptLatest()
  })
  element('edit-receiver').addEventListener('click', () => {
    showFields = true
    update()
    inputs.ingestHost.focus()
  })
  for (const [key, input] of Object.entries(inputs)) input.addEventListener('input', () => {
    draftFields.add(key)
    if (active && sourceId) remember(sourceId)
    update()
  })
  for (const [button, target] of [['copy-command', 'token-command'], ['copy-endpoint', 'windows-endpoint'],
    ['copy-header', 'header-command'], ['copy-settings', 'windows-values']]) {
    element(button).addEventListener('click', async () => {
      const content = element(target)
      try {
        const value = target === 'windows-values' ? Array.from(content.querySelectorAll('dt'), label =>
          `${label.textContent}: ${label.nextElementSibling.firstChild.textContent}`).join('\n') : content.textContent
        await navigator.clipboard.writeText(value)
        element('copy-notice').textContent = '已复制。'
      } catch {
        if (target === 'header-command') element('header-guide').open = true
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(content)
        selection.removeAllRanges()
        selection.addRange(range)
        element('copy-notice').textContent = '已选中文字，请使用系统复制操作。'
      }
    })
  }
  function beginRegistration() {
    const id = registering ? sourceId : options.createId()
    registering = true
    remember(id)
    return id
  }

  function registered(id) {
    registering = false
    remember(id)
  }

  return { open, close, resume, validate, finish, render, beginRegistration, registered,
    get active() { return active }, get completed() { return completed },
    get dirty() { return active && !completed && (draftFields.size > 0 || registering) },
    get busy() { return working || state?.writing || state?.refreshing },
    get blocked() { return Boolean(!state?.saved || state.pending || state.differences || restoredConflict || this.busy) },
  }
}
