(() => {
  const workspace = document.getElementById('configuration-workspace')
  const options = window.usageHubOptions
  const host = window.usageHubHost
  const service = new URL(workspace.dataset.service, window.location.href)
  const panels = new Map()
  const links = [...workspace.querySelectorAll('[data-config-view]')]
  const dashboard = document.getElementById('back-dashboard')
  const back = host.backSearch()
  const returnUrl = new URL('?to=dashboard', service)
  if (back) returnUrl.searchParams.set('back', back)
  dashboard.href = returnUrl.href
  let current
  let sourceHash = ''
  let revision = ''
  let reconnecting
  let serviceRevision = ''
  let optionsWriting = Promise.resolve()

  function route() {
    const { hash } = window.location
    const params = new URLSearchParams(hash.slice(1))
    const selected = params.get('view')
    const view = panels.has(selected) ? selected : workspace.dataset.view
    return { view, hash: view === 'sources' ? options.sourceFragment(hash) : '',
      revision: view === 'status' ? options.revision(params.get('revision')) : '' }
  }

  function address(view, fragment = '', expectedRevision = '') {
    const params = new URLSearchParams(fragment.slice(1))
    params.set('view', view)
    if (view === 'status' && expectedRevision) params.set('revision', expectedRevision)
    return `#${params}`
  }

  function updateLinks() {
    for (const link of links) {
      const view = link.dataset.configView
      link.href = address(view, view === 'sources' ? sourceHash : '', revision)
      if (view === current.view && link.closest('nav')) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
  }

  function show() {
    const next = route()
    if (next.view === current?.view && next.hash === current.hash && next.revision === current.revision) return
    const activeElement = document.activeElement
    const moveFocus = current && next.view !== current.view && activeElement?.closest?.(`#config-${current.view}`)
    if (next.view !== current?.view) panels.get(current?.view)?.leave?.()
    if (next.view === 'sources') sourceHash = next.hash
    if (next.revision) revision = next.revision
    current = next
    for (const view of panels.keys()) document.getElementById(`config-${view}`).hidden = view !== next.view
    document.getElementById('source-toolbar').hidden = next.view !== 'sources'
    updateLinks()
    panels.get(next.view)?.enter(next)
    if (moveFocus) links.find(link => link.dataset.configView === next.view)?.focus({ preventScroll: true })
  }

  async function wakeService() {
    for (const delay of [0, 400, 800, 1200]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      try {
        const expected = serviceRevision
        const init = { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(2500) }
        const root = await fetch(service, init)
        if (!root.ok) continue
        const response = await fetch(new URL('api/status', service), init)
        if (!response.ok) continue
        const status = await response.json()
        if (status?.schema === 'magpie-usage-hub/status-v1' && expected === serviceRevision
          && (!expected || status.loadedRevision === expected)) return
      } catch {}
    }
  }

  function reconnect(expectedRevision) {
    if (expectedRevision !== undefined) serviceRevision = expectedRevision
    else if (!reconnecting) serviceRevision = ''
    reconnecting ??= wakeService().finally(() => { reconnecting = undefined })
    return reconnecting
  }

  function replaceHash(hash) {
    try { window.history.replaceState(null, '', hash) }
    catch { window.location.replace(hash) }
  }

  window.usageHubConfig = {
    register(view, handlers) { panels.set(view, handlers) },
    isActive(view) { return current?.view === view },
    url(path) { return new URL(path, service).href },
    sourceHash() { return sourceHash },
    setSourceHash(fragment) {
      sourceHash = options.sourceFragment(fragment)
      if (current?.view === 'sources') {
        current.hash = sourceHash
        replaceHash(address('sources', sourceHash))
      }
      if (current) updateLinks()
    },
    setRevision(value) { revision = value; if (current) updateLinks() },
    saved(value) {
      this.setRevision(value)
      void reconnect(value)
      if (current?.view === 'status') {
        replaceHash(address('status', '', value))
        show()
      } else if (current?.view === 'sources') panels.get('sources').enter(current)
    },
    submitOptions(operation) {
      const result = optionsWriting.then(operation)
      optionsWriting = result.catch(() => {})
      return result
    },
    reconnect,
    waitForService() { return reconnecting },
  }

  document.addEventListener('DOMContentLoaded', show)
  window.addEventListener('hashchange', show)
  window.addEventListener('popstate', show)
  dashboard.addEventListener('click', async event => {
    if (event.defaultPrevented || !reconnecting || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    await reconnecting
    window.location.assign(dashboard.href)
  })
})()
