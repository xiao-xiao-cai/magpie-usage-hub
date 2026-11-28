import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const navigationScript = readFileSync(new URL('../../ui/configuration-navigation.js', import.meta.url), 'utf8')
const revision = '11111111-1111-4111-8111-111111111111'

class Element extends EventTarget {
  hidden = false
  href = ''
  attributes = new Map<string, string>()
  constructor(readonly id: string, readonly dataset: Record<string, string> = {}, private readonly document?: DocumentState) { super() }
  closest(selector: string) {
    if (selector === 'nav') return this.dataset.configView ? this : null
    if (selector.startsWith('#config-')) return this.dataset.panel === selector.slice('#config-'.length) ? this : null
    return null
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  removeAttribute(name: string) { this.attributes.delete(name) }
  focus() { if (this.document) this.document.activeElement = this }
}

class DocumentState extends EventTarget {
  hidden = false
  activeElement: Element | null = null
  readonly elements = new Map<string, Element>()
  getElementById(id: string) {
    if (!this.elements.has(id)) this.elements.set(id, new Element(id, {}, this))
    return this.elements.get(id)!
  }
}

function harness(hash = '', initialView = 'sources') {
  const document = new DocumentState()
  const location = {
    href: `http://127.0.0.1:3493/?to=${initialView}${hash}`,
    hash,
    assigned: [] as string[],
    replace(value: string) { this.assigned.push(value); this.hash = value.startsWith('#') ? value : this.hash },
    assign(value: string) { this.assigned.push(value) },
  }
  Object.assign(document.getElementById('configuration-workspace'), {
    dataset: { service: 'http://127.0.0.1:3493/', view: initialView },
    querySelectorAll() { return links },
  })
  const links = ['sources', 'settings', 'status'].map(view => {
    const link = new Element(`${view}-link`, { configView: view }, document)
    link.href = `#view=${view}`
    return link
  })
  const panels = new Map(['sources', 'settings', 'status'].map(view => [view, document.getElementById(`config-${view}`)]))
  const toolbar = document.getElementById('source-toolbar')
  const dashboard = document.getElementById('back-dashboard')
  const window = Object.assign(new EventTarget(), {
    location,
    history: { replaceState(_state: unknown, _title: string, value: string) { location.hash = value } },
    usageHubHost: { backSearch: () => '?view=details&period=30d' },
    usageHubOptions: {
      revision(value: unknown) { return typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value) ? value : '' },
      sourceFragment(value: string) { return value.startsWith('#add') || value.startsWith('#source=') ? value : '' },
    },
  })
  let currentView = ''
  const entered: string[] = []
  const left: string[] = []
  runInNewContext(navigationScript, {
    window, document, URL, URLSearchParams, AbortSignal, fetch: async () => new Response(), setTimeout,
  })
  const navigation = (window as typeof window & { usageHubConfig: { register(view: string, panel: {
    enter(route: object): void; leave(): void
  }): void } }).usageHubConfig
  for (const view of ['sources', 'settings', 'status']) navigation.register(view, {
    enter(route) { currentView = view; entered.push(`${view}:${JSON.stringify(route)}`) },
    leave() { left.push(view) },
  })
  document.dispatchEvent(new Event('DOMContentLoaded'))
  function route(hashValue: string, eventName = 'hashchange') {
    location.hash = hashValue
    window.dispatchEvent(new Event(eventName))
  }
  return { document, location, links, panels, toolbar, dashboard, entered, left, route, get currentView() { return currentView } }
}

test('switches configuration panels and browser history without document navigation', () => {
  const ui = harness()
  expect(ui.currentView).toBe('sources')
  ui.route('#view=settings')
  expect(ui.currentView).toBe('settings')
  expect(ui.panels.get('sources')?.hidden).toBe(true)
  expect(ui.panels.get('settings')?.hidden).toBe(false)
  ui.route('#view=status')
  expect(ui.currentView).toBe('status')
  ui.route('#view=sources', 'popstate')
  expect(ui.currentView).toBe('sources')
  expect(ui.left).toEqual(['sources', 'settings', 'status'])
  expect(ui.location.assigned).toEqual([])
  expect(ui.dashboard.href).toBe('http://127.0.0.1:3493/?to=dashboard&back=%3Fview%3Ddetails%26period%3D30d')
  expect(ui.links.find(link => link.dataset.configView === 'sources')?.attributes.get('aria-current')).toBe('page')
})

test('keeps legacy source and diagnostic hashes inside the shared configuration shell', () => {
  const sources = harness('#add', 'sources')
  expect(sources.currentView).toBe('sources')
  expect(sources.entered[0]).toContain('"hash":"#add"')
  const status = harness(`#revision=${revision}`, 'status')
  expect(status.currentView).toBe('status')
  expect(status.entered[0]).toContain(`"revision":"${revision}"`)
})
