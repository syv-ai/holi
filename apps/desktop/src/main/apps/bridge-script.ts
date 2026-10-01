/**
 * `window.holi` — the shim injected into a vault app's entry document.
 *
 * It is a **string**, not a module: the app runs in a frame with an opaque
 * origin and no bundler, so the only way it can have an API is for the served
 * document to carry one. Nothing typechecks it against `APP_METHODS`, so a test
 * asserts every method appears here verbatim.
 *
 * **This is not the renderer's `window.holi`.** That one is the preload bridge
 * (`window.holi.trpc`), in a different document, in a trusted origin. The two
 * objects never meet.
 *
 * `postMessage(..., '*')` is correct rather than lazy: the frame's origin is
 * opaque, so there is no origin string it could target instead. Identity is
 * verified on the other side, by the renderer, which knows which frame it
 * mounted and therefore which app is speaking.
 *
 * A message with `push` and no `id` is the renderer saying something changed;
 * it carries no data, so the app reads it again through the bridge and every
 * refusal still applies.
 */
import { APP_SURFACES } from '@holi/shared'

export const BRIDGE_JS = `(() => {
  const pending = new Map()
  const listeners = new Map()
  addEventListener('message', (e) => {
    if (e.source !== parent) return
    const msg = e.data
    if (!msg) return
    // A push has a topic and no id: something the app can read has changed.
    if (typeof msg.push === 'string') {
      for (const fn of listeners.get(msg.push) || []) {
        try { fn() } catch (err) { console.error(err) }
      }
      return
    }
    if (typeof msg.id !== 'string') return
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.ok) entry.resolve(msg.value)
    else {
      report('warn', ['holi ' + entry.method + ' refused: ' + String(msg.error)])
      entry.reject(new Error(String(msg.error)))
    }
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      pending.set(id, { resolve, reject, method })
      parent.postMessage({ id, method, params }, '*')
    })
  // The app's log (log.local.txt beside its code, for the vault's agent):
  // console errors and warnings, uncaught errors, refused calls, and
  // holi.log(). A burst is capped, so a loop that logs cannot flood Holi.
  let budget = 50
  setInterval(() => { budget = 50 }, 1000)
  const describe = (part) => {
    if (part instanceof Error) return part.stack || String(part)
    if (typeof part === 'string') return part
    try { return JSON.stringify(part) } catch { return String(part) }
  }
  const report = (level, parts) => {
    if (budget <= 0) return
    budget -= 1
    parent.postMessage({ log: { level, text: parts.map(describe).join(' ') } }, '*')
  }
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console)
    console[level] = (...args) => { report(level, args); original(...args) }
  }
  addEventListener('error', (e) => report('error', [e.error || e.message]))
  addEventListener('unhandledrejection', (e) => report('error', ['unhandled rejection:', e.reason]))
  // Listen for a topic: docs, tasks, sync, agent, recents, history, or store:<collection>.
  // Returns the unsubscribe.
  const on = (topic, fn) => {
    if (!listeners.has(topic)) listeners.set(topic, new Set())
    listeners.get(topic).add(fn)
    return () => listeners.get(topic).delete(fn)
  }
  const SURFACES = ${JSON.stringify(APP_SURFACES)}
  const caches = new Map()
  window.holi = {
    docs: {
      list: () => call('docs.list'),
      read: (path) => call('docs.read', { path }),
      render: (path) => call('docs.render', { path }),
    },
    tasks: {
      list: () => call('tasks.list'),
      complete: (path) => call('tasks.complete', { path }),
    },
    // A note's path, or one of Holi's views: home, board, agenda, mail, settings.
    open: (target) =>
      SURFACES.includes(target) ? call('open', { surface: target }) : call('open', { path: target }),
    recents: () => call('vault.recents'),
    search: (q) => call('docs.search', { q }),
    settings: () => call('vault.settings'),
    members: () => call('vault.members'),
    history: (opts) => call('vault.history', opts || {}),
    sync: {
      status: () => call('sync.status'),
    },
    agent: {
      sessions: () => call('agent.sessions'),
    },
    // One person's Google data: needs dangerously-allow in app.yaml, and the
    // person's approval on their machine.
    calendar: {
      events: (range) => call('calendar.events', range),
    },
    mail: {
      threads: (query) => call('mail.threads', query === undefined ? {} : { query }),
    },
    on,
    // A line in the app's log, for whoever debugs it next.
    log: (...parts) => report('info', parts),
    // The app's own records, one JSON object each. put(value) makes an id;
    // put(id, value) uses yours. query(fn) filters the whole collection here,
    // in the frame: a collection is small, and a function cannot cross. The
    // listed collection is kept until a store:<collection> push says it changed.
    store: (collection) => {
      const list = () => call('store.list', { collection }).then((r) => r.records)
      // One cache per collection, however many times the app calls
      // holi.store(c): a put through one handle clears it for all, and the
      // push listener is added once rather than per call.
      if (!caches.has(collection)) {
        const entry = { records: null }
        caches.set(collection, entry)
        on('store:' + collection, () => { entry.records = null })
      }
      const cache = caches.get(collection)
      const cachedList = () => {
        if (cache.records === null) {
          cache.records = list().catch((err) => { cache.records = null; throw err })
        }
        return cache.records
      }
      const changed = (p) => p.then((v) => { cache.records = null; return v })
      return {
        get: (id) => call('store.get', { collection, id }),
        put: (a, b) =>
          changed(
            b === undefined
              ? call('store.put', { collection, value: a })
              : call('store.put', { collection, id: a, value: b }),
          ),
        delete: (id) => changed(call('store.delete', { collection, id })),
        list,
        query: (fn) => cachedList().then((records) => records.filter(fn)),
      }
    },
  }

  // <holi-note path="Notes/plan.md">: a note, rendered by Holi and themed by the
  // injected tokens (custom properties inherit into the shadow root). Its links
  // open in Holi; it renders again when the vault's notes change.
  class HoliNote extends HTMLElement {
    static get observedAttributes() { return ['path'] }
    constructor() {
      super()
      this.attachShadow({ mode: 'open' })
      // A constructed sheet, not a style tag in the markup: the rendered note
      // replaces the root's contents on every render.
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(NOTE_CSS)
      this.shadowRoot.adoptedStyleSheets = [sheet]
      this.shadowRoot.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[data-holi-open]')
        if (!a) return
        e.preventDefault()
        window.holi.open(a.getAttribute('data-holi-open'))
      })
    }
    connectedCallback() {
      this.off = on('docs', () => this.render())
      this.render()
    }
    disconnectedCallback() { if (this.off) this.off() }
    attributeChangedCallback() { if (this.isConnected) this.render() }
    render() {
      const path = this.getAttribute('path')
      if (!path) return
      window.holi.docs.render(path).then(
        (html) => { this.shadowRoot.innerHTML = html },
        (err) => { this.shadowRoot.textContent = String(err.message || err) },
      )
    }
  }
  const NOTE_CSS = ':host{display:block;color:var(--foreground);font:inherit;line-height:1.6}' +
    'a{color:var(--primary)}code,pre{font-family:ui-monospace,monospace;background:var(--muted);border-radius:4px}' +
    'pre{padding:8px 12px;overflow:auto}code{padding:0 3px}pre code{padding:0}' +
    'h1,h2,h3{line-height:1.25}blockquote{margin:0;padding-left:12px;color:var(--muted-foreground)}' +
    'table{border-collapse:collapse}td,th{padding:4px 8px}'
  if (!customElements.get('holi-note')) customElements.define('holi-note', HoliNote)
})()`
