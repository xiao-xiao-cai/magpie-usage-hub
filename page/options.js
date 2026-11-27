const usageHubOptions = (() => {
  const fieldLabels = {
    collectionMode: '查询模式', enabled: '启停', centerGatewayUrl: '中心本机网关',
    requestTimeoutSec: '单次请求超时', configRevision: '保存修订',
  }
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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

  function pullEnabled(saved) {
    return saved?.collectionMode === 'pull' && saved.enabled === true
  }

  function pageServiceLink(service, current, saved) {
    try {
      const url = new URL(service)
      if (url.origin !== new URL(current).origin || !url.pathname.endsWith('/_magpie/service/')) return ''
      const target = new URLSearchParams()
      const selectedRevision = revision(saved?.configRevision)
      if (selectedRevision) target.set('revision', selectedRevision)
      if (pullEnabled(saved)) target.set('view', 'dashboard')
      url.hash = target.toString()
      return url.href
    } catch {
      return ''
    }
  }

  function gateway(value) {
    if (typeof value !== 'string' || !/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(value)) return ''
    try {
      const url = new URL(value)
      return ['127.0.0.1', '[::1]'].includes(url.hostname) ? url.href : ''
    } catch {
      return ''
    }
  }

  function settingsView(saved) {
    const timeout = saved.requestTimeoutSec ?? 30
    return {
      enabled: pullEnabled(saved),
      centerGatewayUrl: gateway(saved.centerGatewayUrl ?? 'http://127.0.0.1:3425'),
      requestTimeoutSec: Number.isFinite(timeout) ? String(timeout) : '',
    }
  }

  function settingsPatch(draft) {
    const centerGatewayUrl = gateway(draft.centerGatewayUrl.trim())
    if (!centerGatewayUrl) throw new FieldError('centerGatewayUrl', '请输入有效的 HTTP(S) 回环网关根地址。')
    const { requestTimeoutSec } = draft
    if (!Number.isInteger(requestTimeoutSec) || requestTimeoutSec < 1 || requestTimeoutSec > 120) {
      throw new FieldError('requestTimeoutSec', '请输入 1 至 120 的整数。')
    }
    return { collectionMode: 'pull', enabled: draft.enabled, centerGatewayUrl, requestTimeoutSec }
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

  return { FieldError, revision, createId, pullEnabled, pageServiceLink, settingsView, settingsPatch, createSession }
})()
