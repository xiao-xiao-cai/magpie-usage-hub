const usageHubOptions = (() => {
  const fieldLabels = Object.freeze({
    enabled: '启停',
    role: '部署角色',
    mode: '运行模式',
    sourceGatewayUrl: '本机源网关',
    sourceCallerKeyId: '专用测试 Key ID',
    sourceProviderId: '供应商 ID',
    centralGatewayUrl: '中心网关',
    centralKeyFile: '上报凭据文件路径',
    pairingCodeFile: '一次性配对码文件路径',
    centerGatewayUrl: '本机中心网关',
    ingestHost: '接收监听地址',
    ingestPort: '接收端口',
    ingestKeyFile: '接收凭据文件路径',
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

  function pageServiceLink(service, current, saved) {
    try {
      const url = new URL(service)
      if (url.origin !== new URL(current).origin || !url.pathname.endsWith('/_magpie/service/')) return ''
      if (saved?.role === 'center') return saved.enabled === true ? new URL('dashboard/', url).href : ''
      const selectedRevision = revision(saved?.configRevision)
      if (!selectedRevision) return ''
      url.hash = `revision=${selectedRevision}`
      return url.href
    } catch {
      return ''
    }
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

  function providerId(value) {
    return typeof value === 'string' && value.length > 0 && [...value].length <= 256
      && !/[\s\u0000-\u001f\u007f]/u.test(value) ? value : ''
  }

  function credentialConfigured(saved, field = 'centralKeyFile') {
    return typeof saved[field] === 'string' && saved[field].trim() !== ''
  }

  function settingsView(saved) {
    const pollSeconds = saved.pollIntervalSec ?? 60
    const timeoutSeconds = saved.requestTimeoutSec ?? 30
    const ingestPort = saved.ingestPort ?? 3494
    return {
      enabled: saved.enabled === true,
      role: saved.role === 'center' ? 'center' : 'source',
      mode: saved.mode === 'continuous' ? 'continuous' : 'managed',
      sourceGatewayUrl: gateway(saved.sourceGatewayUrl, true),
      sourceCallerKeyId: keyId(saved.sourceCallerKeyId),
      sourceProviderId: providerId(saved.sourceProviderId),
      centralGatewayUrl: gateway(saved.centralGatewayUrl, false),
      centralKeyFile: '',
      pairingCodeFile: '',
      centerGatewayUrl: gateway(saved.centerGatewayUrl, true),
      ingestHost: saved.ingestHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
      ingestPort: typeof ingestPort === 'number' ? String(ingestPort) : '',
      ingestKeyFile: '',
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

  function credentialPatch(draft, saved, field, required = false) {
    const file = draft[field].trim()
    if (file && !/^(?:\/|[a-z]:[\\/]|\\\\[^\\])/i.test(file)) {
      throw new FieldError(field, '请输入宿主上的绝对文件路径。')
    }
    if (required && draft.enabled && !file && !credentialConfigured(saved, field)) {
      throw new FieldError(field, '请配置凭据文件。')
    }
    return file ? { [field]: file } : {}
  }

  function centerPatch(draft, saved) {
    const center = gateway(draft.centerGatewayUrl, true)
    if (!center && (draft.enabled || draft.centerGatewayUrl.trim())) {
      throw new FieldError('centerGatewayUrl', '请输入本机中心网关的 HTTP 或 HTTPS 根地址。')
    }
    const { ingestHost, ingestPort } = draft
    if (ingestHost !== '127.0.0.1' && ingestHost !== '0.0.0.0') {
      throw new FieldError('ingestHost', '请选择接收监听地址。')
    }
    if (!Number.isInteger(ingestPort) || ingestPort < 1 || ingestPort > 65535) {
      throw new FieldError('ingestPort', '请输入 1–65535 的整数端口。')
    }
    if (ingestPort === 3493) throw new FieldError('ingestPort', '该端口用于插件页面服务。')
    if (center) {
      const url = new URL(center)
      if (ingestPort === Number(url.port || (url.protocol === 'https:' ? 443 : 80))) {
        throw new FieldError('ingestPort', '接收端口须与本机中心网关的端口不同。')
      }
    }
    return { centerGatewayUrl: center, ingestHost, ingestPort, ...credentialPatch(draft, saved, 'ingestKeyFile') }
  }

  function settingsPatch(draft, saved) {
    const { enabled, role } = draft
    if (role !== 'source' && role !== 'center') throw new FieldError('role', '请选择部署角色。')
    const common = {
      enabled,
      role,
      requestTimeoutSec: readSeconds(draft.requestTimeoutSec, 'requestTimeoutSec', 1, 120),
    }
    if (role === 'center') return { ...common, ...centerPatch(draft, saved) }

    const source = gateway(draft.sourceGatewayUrl, true)
    const center = gateway(draft.centralGatewayUrl, false)
    if (!source && (enabled || draft.sourceGatewayUrl.trim())) {
      throw new FieldError('sourceGatewayUrl', '请输入本机回环网关的 HTTP 或 HTTPS 根地址。')
    }
    if ((!center && (enabled || draft.centralGatewayUrl.trim())) || (center && center === source)) {
      throw new FieldError('centralGatewayUrl', '请输入与源网关不同的 HTTP 或 HTTPS 根地址。')
    }
    if (draft.mode === 'managed') {
      return { ...common, mode: 'managed', sourceGatewayUrl: source, centralGatewayUrl: center,
        ...credentialPatch(draft, saved, 'pairingCodeFile'),
      }
    }
    if (draft.mode !== 'continuous') throw new FieldError('mode', '请选择来源接入方式。')
    const caller = keyId(draft.sourceCallerKeyId.trim())
    const providerInput = draft.sourceProviderId.trim()
    const provider = providerId(providerInput)
    const preservesLegacyScope = !providerInput && saved.mode === 'continuous'
      && saved.role === undefined && saved.sourceProviderId === undefined
    if (!caller && (enabled || draft.sourceCallerKeyId.trim())) {
      throw new FieldError('sourceCallerKeyId', '请输入专用测试 Key ID。')
    }
    if (!provider && (providerInput || (enabled && !preservesLegacyScope))) {
      throw new FieldError('sourceProviderId', '请输入源账本中的供应商 ID。')
    }
    const patch = {
      ...common,
      mode: 'continuous',
      sourceGatewayUrl: source,
      sourceCallerKeyId: caller,
      centralGatewayUrl: center,
      initialMode: draft.initialMode,
      pollIntervalSec: readSeconds(draft.pollIntervalSec, 'pollIntervalSec', 5, 900),
      ...credentialPatch(draft, saved, 'centralKeyFile', true),
    }
    if (preservesLegacyScope) delete patch.role
    if (provider || saved.sourceProviderId !== undefined) patch.sourceProviderId = provider
    return patch
  }

  function sourceBinding(saved) {
    const { sourceGatewayUrl, sourceCallerKeyId, sourceProviderId, centralGatewayUrl, initialMode } = settingsView(saved)
    if (saved.mode !== 'continuous' || !sourceGatewayUrl || !sourceCallerKeyId || !centralGatewayUrl
      || sourceGatewayUrl === centralGatewayUrl) return null
    return { sourceGatewayUrl, sourceCallerKeyId, centralGatewayUrl, initialMode,
      ...(sourceProviderId ? { sourceProviderId } : {}),
    }
  }

  function recoveryBinding(saved) {
    if (saved.enabled !== true || !credentialConfigured(saved) || (saved.role !== undefined && saved.role !== 'source')
      || ((saved.role === 'source' || saved.sourceProviderId !== undefined) && !providerId(saved.sourceProviderId))) return null
    return sourceBinding(saved)
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
        if (action === 'settings' && expected.mode === 'continuous' && expected.recoveryRequest
          && !sameValue(expected.recoveryRequest.binding, sourceBinding(expected))) delete expected.recoveryRequest
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

  return { FieldError, revision, createId, pageServiceLink, credentialConfigured, settingsView, settingsPatch,
    recoveryBinding, recoveryDraft, createSession,
  }
})()
