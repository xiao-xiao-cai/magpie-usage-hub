(() => {
  function fallback(message) {
    const notice = document.getElementById('loading-message')
    notice.textContent = message
    notice.className = 'loading-message'
    document.getElementById('loading-preview').hidden = true
    document.getElementById('settings-link').hidden = false
  }

  async function open() {
    const timeout = setTimeout(() => fallback('宿主尚未响应。请重新打开插件页，或查看中心设置。'), 10_000)
    try {
      await window.magpie.ready
      if (!window.magpie.service) return fallback('请在中心 Magpie Web 打开用量概览。')
      const service = new URL(window.magpie.service, location.href)
      if (service.origin !== location.origin || !service.pathname.endsWith('/_magpie/service/')) throw new Error()
      location.replace(service.origin + service.pathname)
    } catch {
      fallback('暂时无法打开用量概览。请重试，或查看中心设置。')
    } finally {
      clearTimeout(timeout)
    }
  }
  void open()
})()
