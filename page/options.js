const usageHubOptions = (() => {
  const fieldLabels = {
    collectionMode: '采集模式', role: '角色', enabled: '启停', centerGatewayUrl: '中心本机网关',
    ingestHost: '接收监听地址', ingestPort: '接收端口', timeZone: '看板时区',
    sourceGatewayUrl: '来源本机网关', centerIngestUrl: '中心接收地址', sourceId: '来源 ID',
    reportKeyFile: '上报令牌文件',
    requestTimeoutSec: '单次请求超时', configRevision: '保存修订',
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
    return typeof value === 'string' && uuidV4.test(value) ? value : ''
  }

  function createId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  function enabledRole(saved) {
    return saved?.collectionMode === 'push' && saved.enabled === true && ['center', 'sender'].includes(saved.role)
      ? saved.role : ''
  }

  function pageServiceLink(service, current, saved) {
    try {
      const url = new URL(service)
      if (url.origin !== new URL(current).origin || !url.pathname.endsWith('/_magpie/service/')) return ''
      const target = new URLSearchParams()
      const selectedRevision = revision(saved?.configRevision)
      if (selectedRevision) target.set('revision', selectedRevision)
      if (enabledRole(saved) === 'center') target.set('view', 'dashboard')
      url.hash = target.toString()
      return url.href
    } catch {
      return ''
    }
  }

  function rootUrl(value, loopback = false) {
    if (typeof value !== 'string' || !/^https?:\/\/[^/?#@\\\s\u0000-\u001f\u007f]+\/?$/i.test(value)) return ''
    try {
      const url = new URL(value)
      if (url.href !== `${url.origin}/` || (loopback && !['127.0.0.1', '[::1]'].includes(url.hostname))) return ''
      return url.href
    } catch {
      return ''
    }
  }

  function settingsView(saved) {
    const timeout = saved.requestTimeoutSec ?? 30
    const port = saved.ingestPort ?? 3494
    return {
      role: saved.collectionMode === 'push' && saved.role === 'sender' ? 'sender' : 'center',
      enabled: Boolean(enabledRole(saved)),
      centerGatewayUrl: rootUrl(saved.centerGatewayUrl ?? localGateway, true),
      ingestHost: typeof saved.ingestHost === 'string' ? saved.ingestHost : '127.0.0.1',
      ingestPort: Number.isFinite(port) ? String(port) : '',
      timeZone: typeof saved.timeZone === 'string' ? saved.timeZone : 'Asia/Shanghai',
      sourceGatewayUrl: rootUrl(saved.sourceGatewayUrl ?? localGateway, true),
      centerIngestUrl: rootUrl(saved.centerIngestUrl),
      sourceId: revision(saved.sourceId),
      reportKeyFile: typeof saved.reportKeyFile === 'string' ? saved.reportKeyFile : '',
      requestTimeoutSec: Number.isFinite(timeout) ? String(timeout) : '',
    }
  }

  function isListenAddress(value) {
    if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
      return value.split('.').every(part => Number(part) <= 255)
    }
    if (!value.includes(':') || !/^[\da-f:.]+$/i.test(value)) return false
    try { return Boolean(new URL(`http://[${value}]/`).hostname) } catch { return false }
  }

  function isTimeZone(value) {
    if (!/^[A-Za-z][\w+/-]*$/.test(value)) return false
    try { return Boolean(new Intl.DateTimeFormat('en', { timeZone: value })) } catch { return false }
  }

  function settingsPatch(draft) {
    const { role, enabled, requestTimeoutSec } = draft
    if (role !== 'center' && role !== 'sender') throw new FieldError('role', '请选择此实例的角色。')
    if (!Number.isInteger(requestTimeoutSec) || requestTimeoutSec < 1 || requestTimeoutSec > 120) {
      throw new FieldError('requestTimeoutSec', '请输入 1 至 120 的整数。')
    }
    const common = { collectionMode: 'push', role, enabled, requestTimeoutSec }
    if (role === 'center') {
      const centerGatewayUrl = rootUrl(draft.centerGatewayUrl.trim(), true)
      const ingestHost = draft.ingestHost.trim()
      const { ingestPort } = draft
      const timeZone = draft.timeZone.trim()
      if (!centerGatewayUrl) throw new FieldError('centerGatewayUrl', '请输入有效的 HTTP(S) 回环网关根地址。')
      const gateway = new URL(centerGatewayUrl)
      const gatewayPort = Number(gateway.port || (gateway.protocol === 'https:' ? 443 : 80))
      if (!isListenAddress(ingestHost)) throw new FieldError('ingestHost', '请输入监听使用的 IPv4 或 IPv6 地址。')
      if (!Number.isInteger(ingestPort) || ingestPort < 1 || ingestPort > 65535) {
        throw new FieldError('ingestPort', '请输入 1 至 65535 之间的接收端口。')
      }
      if (ingestPort === 3493 || ingestPort === gatewayPort) {
        throw new FieldError('ingestPort', '接收端口与插件页面或本机网关冲突，请填写其他端口。')
      }
      if (!isTimeZone(timeZone)) throw new FieldError('timeZone', '请输入有效的 IANA 时区，例如 Asia/Shanghai。')
      return { ...common, centerGatewayUrl, ingestHost, ingestPort, timeZone }
    }

    const sourceGatewayUrl = rootUrl(draft.sourceGatewayUrl.trim(), true)
    const centerAddress = draft.centerIngestUrl.trim()
    const centerIngestUrl = rootUrl(centerAddress)
    const sourceId = draft.sourceId.trim()
    const reportKeyFile = draft.reportKeyFile.trim()
    if (!sourceGatewayUrl) throw new FieldError('sourceGatewayUrl', '请输入有效的 HTTP(S) 回环网关根地址。')
    if ((enabled || centerAddress) && !centerIngestUrl) throw new FieldError('centerIngestUrl', '请输入有效的 HTTP(S) 中心接收根地址。')
    if ((enabled || sourceId) && !revision(sourceId)) throw new FieldError('sourceId', '请填写来源管理中登记的来源 ID。')
    if ((enabled || reportKeyFile) && (!/^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(reportKeyFile)
      || reportKeyFile.length > 1024 || /[\u0000-\u001f\u007f]/.test(reportKeyFile))) {
      throw new FieldError('reportKeyFile', '请输入令牌文件的完整路径。')
    }
    return { ...common, sourceGatewayUrl, centerIngestUrl, sourceId, reportKeyFile }
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
      publish({ result, saved, writing, refreshing, pending: pending !== null, differences: conflict?.differences })
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

  return { FieldError, revision, createId, enabledRole, pageServiceLink, settingsView, settingsPatch, createSession }
})()
