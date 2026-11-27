(() => {
  const pending = new Map()
  let sequence = 0
  let receivedTheme = false
  const origin = new URL(location.href).origin

  function paint(theme) {
    if (typeof theme?.dark !== 'boolean') return
    const root = document.documentElement
    root.dataset.theme = theme.dark ? 'dark' : 'light'
    for (const key of ['bg', 'card', 'fg', 'fg-2', 'muted', 'faint', 'line', 'accent', 'accent-soft', 'accent-fg', 'font', 'code']) {
      const value = theme.tokens?.[key]
      if (typeof value === 'string' && value) root.style.setProperty(`--magpie-${key}`, value)
    }
  }

  function call(method, params) {
    if (window.parent === window) return Promise.reject(new Error('host_unavailable'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('host_timeout')) }, 10_000)
      pending.set(id, message => {
        clearTimeout(timeout)
        if (message.error) reject(new Error('host_request_failed'))
        else resolve(message.result)
      })
      window.parent.postMessage({ magpie: 1, id, method, params }, origin)
    })
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== origin || event.data?.magpie !== 1) return
    const message = event.data
    if (message.event === 'theme') {
      receivedTheme = true
      paint(message.data)
    }
    const reply = pending.get(message.id)
    if (reply) { pending.delete(message.id); reply(message) }
  })

  function backSearch() {
    const raw = new URL(location.href).searchParams.get('back')
    return window.usageHubOptions.dashboardSearch(raw)
  }
  const host = { backSearch }
  if (location.pathname.endsWith('/sources/')) {
    host.getOptions = () => call('options.get')
    host.setOptions = options => call('options.set', { options })
  }
  window.usageHubHost = host
  void call('hello').then(theme => { if (!receivedTheme) paint(theme) }).catch(() => {})
})()
