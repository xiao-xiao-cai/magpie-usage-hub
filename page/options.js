const usageHubOptions = (() => {
  const fieldLabels = {
    collectionMode: '采集模式', role: '角色', enabled: '启停', centerGatewayUrl: '中心本机网关',
    ingestHost: 'OTLP 监听地址', ingestPort: 'OTLP 接收端口', timeZone: '看板时区',
    requestTimeoutSec: '本机网关请求超时', configRevision: '保存修订', receiverEnabled: '接收开关', publicEndpoint: '设备接收地址',
  }
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const localGateway = 'http://127.0.0.1:3425/'

  class FieldError extends Error {
    constructor(field, message) {
      super(message)
      this.field = field
    }
  }

  function revision(value) {
    return typeof value === 'string' && value.length === 36 && uuidV4.test(value) ? value : ''
  }

  function createId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  function centerEnabled(saved) {
    if (saved && Object.keys(saved).length === 0) return true
    return saved?.enabled === true && saved.role === 'center'
      && (saved.collectionMode === 'otlp' || saved.collectionMode === 'push')
  }

  function dashboardTimestamp(value) {
    if (typeof value !== 'string'
      || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value)
      || /\.\d{3}\d*[1-9]\d*(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return NaN
    const date = value.slice(0, 10)
    const midnight = new Date(`${date}T00:00:00Z`)
    return Number.isFinite(midnight.getTime()) && midnight.toISOString().slice(0, 10) === date ? Date.parse(value) : NaN
  }

  function dashboardSearch(raw) {
    const params = new URLSearchParams(typeof raw === 'string' ? raw : '')
    const filters = new URLSearchParams()
    for (const [key, choices] of Object.entries({ view: ['overview', 'details'], period: ['today', '7d', '30d'],
      via: ['through', 'conversation', 'all'], metric: ['tokens', 'calls', 'cost'], layout: ['cards', 'table'],
    })) {
      const value = params.get(key)
      if (choices.includes(value)) filters.set(key, value)
    }
    const from = params.get('from')
    const to = params.get('to')
    if (params.get('period') === 'custom' && dashboardTimestamp(from) < dashboardTimestamp(to)) {
      filters.set('period', 'custom')
      filters.set('from', from)
      filters.set('to', to)
    }
    const sourceId = params.get('sourceId')
    if (sourceId === 'local' || revision(sourceId)) filters.set('sourceId', sourceId)
    const model = params.get('model')
    if (model !== null && model.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(model)) filters.set('model', model)
    return filters.size ? `?${filters}` : ''
  }

  function publicEndpoint(value) {
    if (typeof value !== 'string' || /[\s\\?#@\u0000-\u001f\u007f]/u.test(value) || !/^https?:\/\/[^/]/iu.test(value)) return ''
    try {
      const url = new URL(value)
      const host = url.hostname.toLowerCase().replace(/\.$/, '')
      if (host.includes('*') || /\/v1\/(?:traces|metrics|logs)\/*$/i.test(url.pathname)
        || host === 'localhost' || host.endsWith('.localhost') || /^(?:127|0)\./.test(host)
        || ['[::]', '[::1]'].includes(host) || /^\[::ffff:(?:7f[\da-f]{2}|[\da-f]{1,2}):/i.test(host)) return ''
      return url.href.replace(/\/+$/, '')
    } catch { return '' }
  }

  function pageServiceLink(service, current, saved) {
    try {
      const url = new URL(service)
      if (url.origin !== new URL(current).origin || url.username || url.password || !url.pathname.endsWith('/_magpie/service/')) return ''
      const target = new URLSearchParams()
      const selectedRevision = revision(saved?.configRevision)
      if (selectedRevision) target.set('revision', selectedRevision)
      if (centerEnabled(saved)) target.set('view', 'dashboard')
      url.search = ''
      url.hash = target.toString()
      return url.href
    } catch {
      return ''
    }
  }

  function gatewayUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\/[^/?#@\\\s\u0000-\u001f\u007f]+\/?$/i.test(value)) return ''
    try {
      const url = new URL(value)
      if (url.href !== `${url.origin}/` || !['127.0.0.1', '[::1]'].includes(url.hostname)) return ''
      return url.href
    } catch {
      return ''
    }
  }

  function settingsView(saved) {
    const timeout = saved.requestTimeoutSec ?? 30
    const port = saved.ingestPort ?? 3494
    return {
      enabled: centerEnabled(saved),
      receiverEnabled: saved.receiverEnabled ?? (saved.enabled === true && centerEnabled(saved)),
      publicEndpoint: publicEndpoint(saved.publicEndpoint),
      centerGatewayUrl: gatewayUrl(saved.centerGatewayUrl ?? (saved.collectionMode && saved.receiverEnabled === undefined ? localGateway : '')),
      ingestHost: saved.ingestHost === undefined ? '127.0.0.1' : isListenAddress(saved.ingestHost) ? saved.ingestHost : '',
      ingestPort: Number.isFinite(port) ? String(port) : '',
      timeZone: typeof saved.timeZone === 'string' ? saved.timeZone : 'Asia/Shanghai',
      requestTimeoutSec: Number.isFinite(timeout) ? String(timeout) : '',
    }
  }

  function isListenAddress(value) {
    if (typeof value !== 'string' || /[^\da-f:.]/i.test(value)) return false
    if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
      return value.split('.').every(part => Number(part) <= 255)
    }
    if (!value.includes(':')) return false
    try { return Boolean(new URL(`http://[${value}]/`).hostname) } catch { return false }
  }

  function receiverFragment(rawHash) {
    const params = new URLSearchParams(typeof rawHash === 'string' ? rawHash.replace(/^#/, '') : '')
    const value = params.get('add')
    if (value === '') return '#add'
    const id = revision(value)
    if (!id) return ''
    const result = new URLSearchParams({ add: id })
    if (params.get('stage') === 'register') result.set('stage', 'register')
    if (params.get('retry') === 'bind') result.set('retry', 'bind')
    const address = params.get('ip')
    if (isListenAddress(address)) result.set('ip', address)
    const port = params.get('port')
    const portNumber = Number(port)
    if (String(portNumber) === port && Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65535) result.set('port', port)
    const endpoint = publicEndpoint(params.get('endpoint'))
    if (endpoint) result.set('endpoint', endpoint)
    const baseline = params.get('revision')
    if (baseline === 'initial' || revision(baseline)) result.set('revision', baseline)
    return `#${result}`
  }

  function isTimeZone(value) {
    if (!/^[A-Za-z][\w+/-]*$/.test(value)) return false
    try { return Boolean(new Intl.DateTimeFormat('en', { timeZone: value })) } catch { return false }
  }

  function settingsPatch(draft) {
    const { enabled, requestTimeoutSec, ingestPort } = draft
    if (!Number.isInteger(requestTimeoutSec) || requestTimeoutSec < 1 || requestTimeoutSec > 120) {
      throw new FieldError('requestTimeoutSec', '请输入 1 至 120 的整数。')
    }
    const address = draft.centerGatewayUrl.trim()
    const centerGatewayUrl = gatewayUrl(address) || undefined
    const ingestHost = draft.ingestHost.trim()
    const timeZone = draft.timeZone.trim()
    if (address && !centerGatewayUrl) throw new FieldError('centerGatewayUrl', '请输入有效的 HTTP(S) 回环网关根地址。')
    const gateway = new URL(centerGatewayUrl ?? localGateway)
    const gatewayPort = Number(gateway.port || (gateway.protocol === 'https:' ? 443 : 80))
    if (!isListenAddress(ingestHost)) throw new FieldError('ingestHost', '请输入监听使用的 IPv4 或 IPv6 地址。')
    if (!Number.isInteger(ingestPort) || ingestPort < 1 || ingestPort > 65535) {
      throw new FieldError('ingestPort', '请输入 1 至 65535 之间的接收端口。')
    }
    if (ingestPort === 3493 || ingestPort === gatewayPort) {
      throw new FieldError('ingestPort', '接收端口与插件页面或本机网关冲突，请填写其他端口。')
    }
    if (!isTimeZone(timeZone)) throw new FieldError('timeZone', '请输入有效的 IANA 时区，例如 Asia/Shanghai。')
    const endpoint = String(draft.publicEndpoint ?? '').trim()
    if (endpoint && !publicEndpoint(endpoint)) throw new FieldError('publicEndpoint', '请输入设备可访问的 HTTP(S) 基础地址。')
    return { collectionMode: 'otlp', role: 'center', enabled, receiverEnabled: draft.receiverEnabled === true,
      publicEndpoint: publicEndpoint(endpoint), requestTimeoutSec, centerGatewayUrl, ingestHost, ingestPort, timeZone }
  }

  function fieldDifferences(expected, actual) {
    return Object.keys(fieldLabels).filter(field => !Object.is(expected[field], actual[field])).map(field => fieldLabels[field])
  }

  function createSession(bridge, publish) {
    let saved = null
    let pending = null
    let conflict = null
    let sequence = 0
    let writing = false
    let refreshing = false

    function report(result) {
      publish({ result, saved, writing, refreshing, pending: pending !== null, latest: conflict?.latest, differences: conflict?.differences })
    }

    async function read() {
      const value = await bridge.get()
      if (value === undefined || value === null) return {}
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_options')
      return value
    }

    function acceptRead(latest) {
      const previous = pending ?? saved
      const differences = previous ? fieldDifferences(previous, latest) : []
      const isReadback = pending !== null
      pending = null
      conflict = differences.length ? { latest, differences } : null
      if (conflict) return isReadback ? 'readback_mismatch' : 'conflict'
      saved = latest
      return isReadback ? 'confirmed' : 'loaded'
    }

    async function refresh() {
      if (writing) return
      const request = ++sequence
      refreshing = true
      report('loading')
      let result = pending ? 'readback_failed' : 'read_failed'
      try {
        const latest = await read()
        if (sequence === request) result = acceptRead(latest)
      } catch {}
      if (sequence !== request) return
      refreshing = false
      report(result)
    }

    async function submit(patch) {
      if (!saved || writing || refreshing || pending || conflict) return
      writing = true
      report('writing')
      let result = 'preflight_failed'
      try {
        const latest = await read()
        const differences = fieldDifferences(saved, latest)
        if (differences.length) {
          conflict = { latest, differences }
          result = 'conflict'
          return
        }
        const expected = { ...latest, ...patch, configRevision: createId() }
        result = 'write_failed'
        await bridge.set(expected)
        pending = expected
        result = 'readback_failed'
        result = acceptRead(await read())
      } catch {
      } finally {
        writing = false
        report(result)
      }
    }

    function adoptLatest() {
      if (!conflict || writing || refreshing) return
      saved = conflict.latest
      conflict = null
      report('rebased')
    }

    return { refresh, submit, adoptLatest }
  }

  return { FieldError, revision, createId, centerEnabled, dashboardSearch, dashboardTimestamp, pageServiceLink, publicEndpoint,
    receiverFragment, settingsView, settingsPatch, createSession }
})()
if (typeof window !== 'undefined') window.usageHubOptions = usageHubOptions
