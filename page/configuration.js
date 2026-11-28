(() => {
  const options = usageHubOptions
  const element = id => document.getElementById(id)
  const inputs = Object.fromEntries(Object.keys(options.settingsView({})).map(name => [name, element(name)]))
  const offInputs = { enabled: element('enabled-off'), receiverEnabled: element('receiverEnabled-off') }
  const form = element('settings-form')
  const retry = element('retry-save')
  const reload = element('reload-options')
  const rebase = element('rebase-options')
  const settingsMessage = element('settings-message')
  const savedToast = element('settings-saved')
  const destinations = [['return-dashboard', 'dashboard'], ['sources-link', 'sources'], ['diagnostic-link', 'status']]
  const optionsWriteIntervalMs = 1000
  let saved
  let snapshot
  let submitted
  let queued
  let saving
  let toastTimer
  let nextWriteAt = 0

  const failures = {
    read_failed: '暂时无法读取设置。请重试，或重新打开插件页。',
    preflight_failed: '提交前无法读取最新设置。草稿已保留，请重试。',
    write_failed: '提交失败。草稿已保留，请重试。',
    readback_failed: '提交结果待确认。请重新读取设置。',
    readback_mismatch: '读回值与本次提交不一致。请核对更新项，草稿已保留。',
    conflict: '其他会话已更新设置。请核对更新项，草稿已保留。',
  }

  async function readOptions() {
    let timer
    try {
      return await Promise.race([
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('bridge_timeout')), 12_000) }),
        Promise.resolve().then(async () => {
          await window.magpie.ready
          return window.magpie.options.get()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  function message(text, alert = false) {
    settingsMessage.textContent = text
    settingsMessage.toggleAttribute('data-alert', alert)
    if (alert) savedToast.textContent = ''
  }

  function inputValue(name) {
    return Object.hasOwn(offInputs, name) ? inputs[name].checked : inputs[name].value
  }

  function hasDraft(values) {
    return Object.entries(options.settingsView(saved)).some(([name, value]) => (values ? values[name] : inputValue(name)) !== value)
  }

  function renderSettings(newSaved, baseline = options.settingsView(saved ?? {})) {
    for (const [name, value] of Object.entries(options.settingsView(newSaved))) {
      if (saved && inputValue(name) !== baseline[name]) continue
      if (Object.hasOwn(offInputs, name)) {
        inputs[name].checked = value
        offInputs[name].checked = !value
      } else if (inputs[name].value !== value) inputs[name].value = value
    }
    saved = newSaved
  }

  function updateDiagnosticLink() {
    const revision = options.revision(saved?.configRevision)
    element('revision-value').textContent = revision
    element('settings-revision').hidden = !revision
    const href = saved && options.pageServiceLink(window.magpie?.service, window.location.href, saved)
    if (!href) return
    const back = options.dashboardSearch(new URL(window.location.href).searchParams.get('back'))
    for (const [id, view] of destinations) {
      const url = new URL(href)
      url.searchParams.set('to', view)
      if (back) url.searchParams.set('back', back)
      element(id).href = url.href
      element(id).hidden = false
    }
  }

  function render(state) {
    snapshot = state
    const { result, differences, refreshing, writing, pending } = state
    if (result === 'confirmed') {
      renderSettings(state.saved, submitted)
      submitted = undefined
    } else if (state.saved && state.saved !== saved) renderSettings(state.saved)
    updateDiagnosticLink()
    element('migration-guide').hidden = saved?.enabled !== true || options.centerEnabled(saved)
    const busy = writing || refreshing
    reload.hidden = result !== 'read_failed' && result !== 'readback_failed'
    rebase.hidden = !differences
    rebase.disabled = busy
    const unsaved = saved && hasDraft()
    retry.hidden = !(unsaved && (['write_failed', 'preflight_failed', 'rebased'].includes(result) || result === 'confirmed' && !queued))
    element('settings-recovery').hidden = retry.hidden && reload.hidden && rebase.hidden
    element('settings-fields').disabled = !saved || pending
    form.setAttribute('aria-busy', String(busy))
    const differenceList = element('options-difference')
    differenceList.hidden = !differences
    differenceList.replaceChildren(...(differences ?? []).map(label => {
      const item = document.createElement('li')
      item.textContent = label
      return item
    }))

    if (Object.hasOwn(failures, result)) message(failures[result], true)
    if (result === 'loading') message('正在读取已保存设置…')
    if (result === 'writing') {
      savedToast.textContent = ''
      message('正在保存…')
    }
    if (result === 'loaded') message(unsaved ? '设置已刷新。草稿已保留。' : '')
    if (result === 'rebased') message(unsaved ? '已读取最新设置。请核对保留的草稿。' : '已读取最新设置。')
    if (result === 'confirmed') {
      message(unsaved ? '有未保存的更改。' : '')
      if (!unsaved) {
        savedToast.textContent = '已保存'
        clearTimeout(toastTimer)
        toastTimer = setTimeout(() => { savedToast.textContent = '' }, 1500)
      }
    }
  }

  const session = options.createSession({
    get: readOptions,
    async set(candidate) {
      try {
        await window.magpie.options.set(candidate)
      } finally {
        nextWriteAt = performance.now() + optionsWriteIntervalMs
      }
    },
  }, render)

  async function saveQueued() {
    while (queued) {
      if (!hasDraft(queued.values)) {
        queued = undefined
        message(hasDraft() ? '有未保存的更改。' : '')
        continue
      }
      const delay = Math.ceil(nextWriteAt - performance.now())
      if (delay > 0) {
        form.setAttribute('aria-busy', 'true')
        message('正在保存…')
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }
      const { values, ingestPort, requestTimeoutSec } = queued
      queued = undefined
      try {
        const patch = options.settingsPatch({ ...values, ingestPort, requestTimeoutSec })
        if (!hasDraft(options.settingsView(patch))) {
          renderSettings(saved, values)
          message(hasDraft() ? '有未保存的更改。' : '')
          continue
        }
        submitted = values
        await session.submit(patch)
        if (snapshot.result === 'confirmed') continue
      } catch (error) {
        if (error instanceof options.FieldError) {
          element(error.field).setAttribute('aria-invalid', 'true')
          message(error.message, true)
        } else message('暂时无法保存，请重试。', true)
      }
      queued = undefined
    }
  }

  function dispatchSubmit() {
    form.dispatchEvent(new Event('submit', { cancelable: true }))
  }

  reload.addEventListener('click', () => void session.refresh())
  rebase.addEventListener('click', session.adoptLatest)
  retry.addEventListener('click', dispatchSubmit)
  for (const [id] of destinations) {
    const link = element(id)
    link.addEventListener('click', async event => {
      if (!saving) return
      event.preventDefault()
      await saving
      if (snapshot.result === 'confirmed' && !hasDraft()) window.location.assign(link.href)
    })
  }
  for (const input of [...Object.values(inputs), ...Object.values(offInputs)]) {
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid')
      if (saved && !saving && !snapshot.differences && !snapshot.pending) message(hasDraft() ? '有未保存的更改。' : '')
    })
    input.addEventListener('change', dispatchSubmit)
  }
  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && event.target.tagName === 'INPUT'
      && event.target.type !== 'radio') {
      event.preventDefault()
      dispatchSubmit()
    }
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (!saved || snapshot.refreshing || snapshot.pending || snapshot.differences) return
    queued = {
      values: Object.fromEntries(Object.keys(inputs).map(name => [name, inputValue(name)])),
      ingestPort: inputs.ingestPort.valueAsNumber,
      requestTimeoutSec: inputs.requestTimeoutSec.valueAsNumber,
    }
    if (!saving) saving = saveQueued().finally(() => {
      saving = undefined
      form.setAttribute('aria-busy', String(snapshot.writing || snapshot.refreshing))
    })
  })
  void session.refresh()
})()
