const usageHubOptions = (() => {
  const fieldLabels = Object.freeze({
    enabled: '启停',
    mode: '运行模式',
    sourceGatewayUrl: '本机源网关',
    sourceCallerKeyId: '专用测试 Key ID',
    centralGatewayUrl: '中心网关',
    centralKeyFile: '上报凭据文件路径',
    initialMode: '首次起点',
    pollIntervalSec: '轮询间隔',
    requestTimeoutSec: '单次请求超时',
    configRevision: '保存修订',
    recoveryRequest: '回填请求',
  })
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

  function sameValue(left, right) {
    if (left === right) return true
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
    if (Array.isArray(left) !== Array.isArray(right)) return false
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length
      && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  }

  function fieldDifferences(expected, actual, allFields = false) {
    const managed = Object.keys(fieldLabels)
    const differences = managed.filter(key => !sameValue(expected[key], actual[key])).map(key => fieldLabels[key])
    if (allFields) {
      const other = new Set([...Object.keys(expected), ...Object.keys(actual)])
      if ([...other].some(key => !Object.hasOwn(fieldLabels, key) && !sameValue(expected[key], actual[key]))) {
        differences.push('其他选项')
      }
    }
    return differences
  }

  function gateway(value, local) {
    if (typeof value !== 'string' || value.trim() === '') return ''
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
      if (url.username || url.password || url.href !== `${url.origin}/`) return ''
      if (local && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') return ''
      return url.href
    } catch {
      return ''
    }
  }

  function keyId(value) {
    return typeof value === 'string' && value !== 'none' && /^[a-zA-Z0-9_-]+$/.test(value) ? value : ''
  }

  function credentialConfigured(saved) {
    return typeof saved.centralKeyFile === 'string' && saved.centralKeyFile.trim() !== ''
  }

  function settingsView(saved) {
    const pollSeconds = saved.pollIntervalSec ?? 60
    const timeoutSeconds = saved.requestTimeoutSec ?? 30
    return {
      enabled: saved.enabled === true,
      sourceGatewayUrl: gateway(saved.sourceGatewayUrl, true),
      sourceCallerKeyId: keyId(saved.sourceCallerKeyId),
      centralGatewayUrl: gateway(saved.centralGatewayUrl, false),
      centralKeyFile: '',
      initialMode: saved.initialMode === 'start' ? 'start' : 'now',
      pollIntervalSec: typeof pollSeconds === 'number' ? String(pollSeconds) : '',
      requestTimeoutSec: typeof timeoutSeconds === 'number' ? String(timeoutSeconds) : '',
    }
  }

  function readSeconds(value, field, minimum, maximum) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new FieldError(field, `${fieldLabels[field]}须为 ${minimum}–${maximum} 秒内的整数。`)
    }
    return value
  }

  function settingsPatch(draft, saved) {
    const { enabled } = draft
    const source = gateway(draft.sourceGatewayUrl, true)
    const center = gateway(draft.centralGatewayUrl, false)
    const caller = keyId(draft.sourceCallerKeyId.trim())
    const keyFile = draft.centralKeyFile.trim()
    if (!source && (enabled || draft.sourceGatewayUrl.trim())) {
      throw new FieldError('sourceGatewayUrl', '请输入本机回环网关的 HTTP 或 HTTPS 根地址。')
    }
    if (!caller && (enabled || draft.sourceCallerKeyId.trim())) {
      throw new FieldError('sourceCallerKeyId', '请输入专用测试 Key ID。')
    }
    if ((!center && (enabled || draft.centralGatewayUrl.trim())) || (center && center === source)) {
      throw new FieldError('centralGatewayUrl', '请输入与源网关不同的 HTTP 或 HTTPS 根地址。')
    }
    if (keyFile && !/^(?:\/|[a-z]:[\\/]|\\\\[^\\])/i.test(keyFile)) {
      throw new FieldError('centralKeyFile', '请输入宿主上的绝对文件路径。')
    }
    if (enabled && !keyFile && !credentialConfigured(saved)) {
      throw new FieldError('centralKeyFile', '请配置上报凭据文件。')
    }

    const patch = {
      enabled,
      mode: 'continuous',
      sourceGatewayUrl: source,
      sourceCallerKeyId: caller,
      centralGatewayUrl: center,
      initialMode: draft.initialMode,
      pollIntervalSec: readSeconds(draft.pollIntervalSec, 'pollIntervalSec', 5, 900),
      requestTimeoutSec: readSeconds(draft.requestTimeoutSec, 'requestTimeoutSec', 1, 120),
    }
    return keyFile ? { ...patch, centralKeyFile: keyFile } : patch
  }

  function recoveryBinding(saved) {
    const { enabled, sourceGatewayUrl, sourceCallerKeyId, centralGatewayUrl, initialMode } = settingsView(saved)
    if (!enabled || saved.mode !== 'continuous' || !sourceGatewayUrl || !sourceCallerKeyId || !centralGatewayUrl
      || sourceGatewayUrl === centralGatewayUrl || !credentialConfigured(saved)) return null
    return { sourceGatewayUrl, sourceCallerKeyId, centralGatewayUrl, initialMode }
  }

  function localTime(value, field) {
    const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/.exec(value)
    if (match) {
      const date = new Date(value)
      const [, year, month, day, hour, minute, second = '0'] = match
      if (date.getFullYear() === Number(year) && date.getMonth() + 1 === Number(month)
        && date.getDate() === Number(day) && date.getHours() === Number(hour)
        && date.getMinutes() === Number(minute) && date.getSeconds() === Number(second)) return date
    }
    throw new FieldError(field, '请输入有效的本地时间。')
  }

  function recoveryDraft(binding, kind, fromInput, toInput, now = Date.now()) {
    if (!binding) throw new FieldError('enabled', '请先保存并启用同步设置。')
    if (kind !== 'range' && kind !== 'cursor') throw new FieldError('recovery-kind', '请选择回填方式。')
    const from = localTime(fromInput, 'recovery-from')
    if (from.getTime() > now) throw new FieldError('recovery-from', '起点须在当前时间或之前。')
    const request = { binding, kind, from: from.toISOString() }
    if (kind === 'cursor') return request

    const to = localTime(toInput, 'recovery-to')
    if (to <= from || to.getTime() > now) {
      throw new FieldError('recovery-to', '截止须晚于起点，并在当前时间或之前。')
    }
    return { ...request, to: to.toISOString() }
  }

  function createSession(bridge, onUpdate) {
    let saved = null
    let pending = null
    let conflict = null
    let sequence = 0
    let writing = false
    let refreshing = false

    function publish(result, action = 'settings') {
      onUpdate({ result, action, saved, writing, refreshing, pending: pending !== null, differences: conflict?.differences })
    }

    async function read() {
      const value = await bridge.get()
      if (value === undefined || value === null) return {}
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_options')
      return value
    }

    function acceptRead(latest) {
      const differences = pending ? fieldDifferences(pending.expected, latest, true)
        : (saved ? fieldDifferences(saved, latest) : [])
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
      const action = pending?.action ?? 'settings'
      refreshing = true
      publish('loading', action)
      let result = pending ? 'readback_failed' : 'read_failed'
      try {
        const latest = await read()
        if (sequence === request) result = acceptRead(latest)
      } catch {
        result = pending ? 'readback_failed' : 'read_failed'
      }
      if (sequence !== request) return
      refreshing = false
      publish(result, action)
    }

    async function submit(action, patch) {
      if (!saved || writing || refreshing || pending || conflict) return
      writing = true
      publish('writing', action)
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
        if (action === 'withdraw') delete expected.recoveryRequest
        result = 'write_failed'
        await bridge.set(expected)
        pending = { expected, action }
        result = 'readback_failed'
        result = acceptRead(await read())
      } catch {
      } finally {
        writing = false
        publish(result, action)
      }
    }

    function adoptLatest() {
      if (!conflict || writing || refreshing) return
      saved = conflict.latest
      conflict = null
      publish('rebased')
    }

    return { refresh, submit, adoptLatest }
  }

  return { FieldError, revision, createId, credentialConfigured, settingsView, settingsPatch, recoveryBinding, recoveryDraft, createSession }
})()
