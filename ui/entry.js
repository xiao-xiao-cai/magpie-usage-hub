(() => {
  const back = window.usageHubHost.backSearch()
  const isCenter = document.querySelector('meta[name="center-available"]').content === 'yes'
  if (isCenter) {
    location.replace(`dashboard/${back}`)
  } else {
    const notice = document.getElementById('entry-message')
    notice.textContent = '中心用量暂不可用。可在配置中查看中心设置。'
    notice.className = 'loading-message'
    document.getElementById('loading-preview').hidden = true
    const configure = document.getElementById('configure')
    if (back) configure.href = `../../settings.html?${new URLSearchParams({ back })}`
    configure.hidden = false
  }
})()
