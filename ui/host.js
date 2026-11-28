(() => {
  const pending = new Map()
  let sequence = 0
  let usageDisplayRead = 0
  let receivedTheme = false
  const origin = new URL(location.href).origin
  const dashboard = location.pathname.endsWith('/dashboard/')

  function paint(theme) {
    if (typeof theme?.dark !== 'boolean') return
    const root = document.documentElement
    root.dataset.theme = theme.dark ? 'dark' : 'light'
    for (const key of ['bg', 'card', 'fg', 'fg-2', 'muted', 'faint', 'line', 'accent', 'accent-soft', 'accent-fg', 'font', 'code']) {
      const value = theme.tokens?.[key]
      if (typeof value === 'string' && value) root.style.setProperty(`--magpie-${key}`, value)
    }
    if (typeof theme.lang === 'string') updateUsageDisplay({ lang: theme.lang })
  }

  function updateUsageDisplay(change) {
    const previous = host.usageDisplay
    const next = { ...previous, ...change }
    if (previous.lang === next.lang && previous.chineseUnits === next.chineseUnits && previous.rate === next.rate) return
    host.usageDisplay = next
    window.dispatchEvent(new Event('usage-display-change'))
  }

  async function readUsageDisplay() {
    const read = ++usageDisplayRead
    void readUsageUnits(read)
    try {
      const display = await call('read', { name: 'usage:day' })
      if (read !== usageDisplayRead || (display?.currency !== 'usd' && display?.currency !== 'cny')) return
      const rate = display.currency === 'cny' && Number.isFinite(display.rate) && display.rate > 0 ? display.rate : 0
      updateUsageDisplay({ rate })
    } catch {}
  }

  async function readUsageUnits(read) {
    const token = document.querySelector('meta[name="usage-query-token"]')?.content
    if (!/^[0-9a-f]{64}$/u.test(token ?? '')) return
    try {
      const response = await fetch('../api/usage-display', { headers: { 'X-Magpie-Usage-Query': token },
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5_000) })
      if (!response.ok) return
      const display = await response.json()
      if (read === usageDisplayRead && typeof display?.chineseUnits === 'boolean') updateUsageDisplay({ chineseUnits: display.chineseUnits })
    } catch {}
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
    if (dashboard && message.event === 'visibility' && message.data?.visible === true) void readUsageDisplay()
    const reply = pending.get(message.id)
    if (reply) { pending.delete(message.id); reply(message) }
  })

  function backSearch() {
    const raw = new URL(location.href).searchParams.get('back')
    return window.usageHubOptions.dashboardSearch(raw)
  }
  const host = { backSearch, usageDisplay: { lang: 'zh', chineseUnits: false, rate: 0 } }
  if (location.pathname.endsWith('/sources/')) {
    host.getOptions = () => call('options.get')
    host.setOptions = options => call('options.set', { options })
  }
  window.usageHubHost = host
  void call('hello').then(theme => {
    if (!receivedTheme) paint(theme)
    if (dashboard && theme?.visible !== false) void readUsageDisplay()
  }).catch(() => {})
})()
