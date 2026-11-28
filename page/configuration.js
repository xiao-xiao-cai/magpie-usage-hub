(() => {
  const options = usageHubOptions
  const element = id => document.getElementById(id)
  const inputs = Object.fromEntries(Object.keys(options.settingsView({})).map(name => [name, element(name)]))
  const form = element('settings-form')
  const save = element('save-settings')
  const settingsMessage = element('settings-message')
  let saved
  let snapshot
  let dirtyFields = new Set()

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
  }

  function inputValue(name) {
    return name === 'enabled' || name === 'receiverEnabled' ? inputs[name].checked : inputs[name].value
  }

  function readDirtyFields() {
    const baseline = options.settingsView(saved ?? {})
    return new Set(Object.keys(inputs).filter(name => inputValue(name) !== baseline[name]))
  }

  function renderSettings(newSaved, reset) {
    saved = newSaved
    for (const [name, value] of Object.entries(options.settingsView(saved))) {
      if (!reset && dirtyFields.has(name)) continue
      if (name === 'enabled' || name === 'receiverEnabled') inputs[name].checked = value
      else inputs[name].value = value
    }
    dirtyFields = readDirtyFields()
  }

  function updateDiagnosticLink() {
    const revision = options.revision(saved?.configRevision)
    element('revision-value').textContent = revision
    element('settings-revision').hidden = !revision
    const href = saved && options.pageServiceLink(window.magpie?.service, window.location.href, saved)
    if (!href) return
    const back = options.dashboardSearch(new URL(window.location.href).searchParams.get('back'))
    for (const [id, view] of [['return-dashboard', 'dashboard'], ['sources-link', 'sources'], ['diagnostic-link', 'status'], ['settings-diagnostics', 'status']]) {
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
    if (state.saved && (state.saved !== saved || result === 'confirmed')) renderSettings(state.saved, result === 'confirmed')
    updateDiagnosticLink()
    element('migration-guide').hidden = saved?.enabled !== true || options.centerEnabled(saved)
    const busy = writing || refreshing
    element('reload-options').disabled = writing
    element('settings-fields').disabled = !saved || writing || pending
    element('rebase-options').disabled = busy
    element('rebase-options').hidden = !differences
    save.disabled = !saved || busy || pending || Boolean(differences)
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
    if (result === 'writing') message('正在提交并核对读回值…')
    if (result === 'loaded') message(dirtyFields.size ? '设置已刷新。草稿已保留。' : '')
    if (result === 'rebased') message(dirtyFields.size ? '已读取最新设置。请核对保留的草稿。' : '已读取最新设置。')
    if (result === 'confirmed') message('设置已保存。可在后台诊断核对采用的修订。')
  }

  const session = options.createSession({
    get: readOptions,
    set: candidate => window.magpie.options.set(candidate),
  }, render)

  function dispatchSubmit(event) {
    event.preventDefault()
    if (!save.disabled) form.dispatchEvent(new Event('submit', { cancelable: true }))
  }

  element('reload-options').addEventListener('click', () => void session.refresh())
  element('rebase-options').addEventListener('click', session.adoptLatest)
  for (const input of Object.values(inputs)) {
    input.addEventListener('input', () => {
      dirtyFields = readDirtyFields()
      if (!snapshot.differences && !snapshot.pending) message(dirtyFields.size ? '有未保存的更改。' : '')
    })
  }
  save.addEventListener('click', dispatchSubmit)
  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && event.target.tagName === 'INPUT'
      && event.target.type !== 'checkbox') dispatchSubmit(event)
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (save.disabled) return
    try {
      const draft = Object.fromEntries(Object.keys(inputs).map(name => [name, inputValue(name)]))
      void session.submit(options.settingsPatch({ ...draft,
        ingestPort: inputs.ingestPort.valueAsNumber,
        requestTimeoutSec: inputs.requestTimeoutSec.valueAsNumber,
      }))
    } catch (error) {
      if (error instanceof options.FieldError) {
        message(error.message, true)
        element(error.field).focus()
      } else {
        message('暂时无法保存，请重试。', true)
      }
    }
  })
  void session.refresh()
})()
