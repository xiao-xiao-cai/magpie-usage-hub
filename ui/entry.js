(() => {
  const url = new URL(location.href)
  const back = window.usageHubHost.backSearch()
  const destination = url.searchParams.get('to') ?? 'dashboard'
  const isCenter = document.querySelector('meta[name="center-available"]').content === 'yes'
  if (destination === 'status' || (destination === 'sources' && isCenter)) {
    const target = new URL(`${destination}/`, url)
    if (back) target.searchParams.set('back', back)
    if (destination === 'status') {
      const revision = window.usageHubOptions.revision(new URLSearchParams(url.hash.slice(1)).get('revision'))
      if (revision) target.hash = new URLSearchParams({ revision }).toString()
    }
    if (destination === 'sources') target.hash = window.usageHubOptions.receiverFragment(url.hash)
    location.replace(target.href)
  } else if (isCenter) {
    location.replace(`dashboard/${back}`)
  } else {
    document.getElementById('entry-message').textContent = '中心用量暂不可用。可在配置中查看中心设置。'
    document.getElementById('loading-preview').hidden = true
    const configure = document.getElementById('configure')
    if (back) configure.href = `../../settings.html?${new URLSearchParams({ back })}`
    configure.hidden = false
  }
})()
