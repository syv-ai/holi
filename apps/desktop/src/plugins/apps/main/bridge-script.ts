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
import { APP_LOG_MAX_TEXT } from '../shared/store'

/** Log entries a frame may send a second: info (console.log and console.info),
 *  and everything else. */
const INFO_PER_SECOND = 20
const OTHER_PER_SECOND = 50

export const BRIDGE_JS = `(() => {
  const nonce = document.querySelector('meta[name="holi-app-document-nonce"]')?.content
  if (!nonce) return
  const pending = new Map()
  const listeners = new Map()
  addEventListener('message', (e) => {
    if (e.source !== parent) return
    const msg = e.data
    if (!msg || msg.nonce !== nonce) return
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
      const err = new Error(String(msg.error))
      if (typeof msg.code === 'string') err.code = msg.code
      entry.reject(err)
    }
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      pending.set(id, { resolve, reject, method })
      parent.postMessage({ id, method, params, nonce }, '*')
    })
  // The app's log (log.local.txt beside its code, for the vault's agent):
  // the console, uncaught errors, refused calls, and holi.log(). A burst is
  // capped, so a loop that logs cannot flood Holi, and info (console.log and
  // console.info) has a smaller budget of its own. An entry is cut to what
  // the log keeps of it before it is sent.
  const BUDGET = { info: ${INFO_PER_SECOND}, other: ${OTHER_PER_SECOND} }
  let budget = { ...BUDGET }
  setInterval(() => { budget = { ...BUDGET } }, 1000)
  const MAX = ${APP_LOG_MAX_TEXT}
  const describe = (part) => {
    if (part instanceof Error) return part.stack || String(part)
    if (typeof part === 'string') return part
    try { return JSON.stringify(part) } catch { return String(part) }
  }
  const report = (level, parts) => {
    const kind = level === 'info' ? 'info' : 'other'
    if (budget[kind] <= 0) return
    budget[kind] -= 1
    const out = []
    let size = 0
    for (const part of parts) {
      if (size >= MAX) break
      const text = String(describe(part)).slice(0, MAX)
      out.push(text)
      size += text.length + 1
    }
    parent.postMessage({ nonce, log: { level, text: out.join(' ').slice(0, MAX) } }, '*')
  }
  // console.log and console.info are both info: the log has no level below it.
  for (const [method, level] of [['error', 'error'], ['warn', 'warn'], ['info', 'info'], ['log', 'info']]) {
    const original = console[method].bind(console)
    console[method] = (...args) => { report(level, args); original(...args) }
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
  const caches = new Map()
  window.holi = {
    docs: {
      list: () => call('docs.list'),
      read: (path) => call('docs.read', { path }),
      render: (path) => call('docs.render', { path }),
      // The whole text, over base: the text you read, or null for a new note.
      // Refused when the note changed since; read it again and retry.
      write: (path, text, base) => call('docs.write', { path, text, base }),
    },
    tasks: {
      list: () => call('tasks.list'),
      complete: (path) => call('tasks.complete', { path }),
      // Fields as the board sets them; null clears one. Done is completion.
      update: (path, patch) => call('tasks.update', { path, patch }),
      // { title, folder?, status?, description?, extra?: { due, priority, ... }, shared? }
      create: (task) => call('tasks.create', task),
    },
    // A note's path, or one of Holi's views by name (home, board, settings).
    // Holi decides which: a view this vault has wins over a file.
    open: (target) => call('open', { target }),
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
    google: {
      agenda: (range) => call('google.agenda', range || {}),
      search: (query) => call('google.search', query === undefined ? {} : { query }),
    },
    // A secret from the vault's .env (.env.local wins), or null when unset:
    // only the names app.yaml lists under env.
    env: (name) => call('env.get', { name }),
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

export const APP_HINTS_JS = `(() => {
  const nonce = document.querySelector('meta[name="holi-app-document-nonce"]')?.content
  if (!nonce || parent === window) return
  const selector = 'button,a[href],[role="link"],summary,input[type="button"],input[type="submit"],input[type="reset"],input[type="checkbox"],input[type="radio"],[role="button"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="treeitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"]:not(input),[role="option"],[cmdk-item]'
  const overlays = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-slot="popover-content"],[data-slot="hover-card-content"]'
  let targets = new Map(), activeRequest = '', enabled = false, sequence = 0, raf = 0, composing = false, activating = false
  const send = (message) => parent.postMessage({ ...message, nonce }, '*')
  const editable = (el) => el instanceof Element && !!el.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')
  const invalidate = () => {
    if (!activeRequest) return
    const requestId = activeRequest
    activeRequest = ''; targets.clear()
    if (raf) cancelAnimationFrame(raf)
    raf = 0; send({ type: 'invalidate', requestId })
  }
  const visible = (el) => {
    if (!el.isConnected || el.matches(':disabled,[disabled],[hidden],[inert],[aria-disabled="true"]')) return false
    for (let n=el; n instanceof Element; n=n.parentElement) {
      if (n.matches('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]')) return false
      const s=getComputedStyle(n)
      if (s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity||1)===0) return false
    }
    const r=el.getBoundingClientRect(); return r.width>0&&r.height>0
  }
  const pointFor = (el, overlay, pressable = true) => {
    const r=el.getBoundingClientRect(); let l=Math.max(0,r.left),t=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom)
    for (let n=el.parentElement;n;n=n.parentElement) { const s=getComputedStyle(n),b=n.getBoundingClientRect(); if (/(hidden|clip|auto|scroll)/.test(s.overflowX)){l=Math.max(l,b.left);right=Math.min(right,b.right)} if (/(hidden|clip|auto|scroll)/.test(s.overflowY)){t=Math.max(t,b.top);bottom=Math.min(bottom,b.bottom)} }
    if(right<=l||bottom<=t)return null
    const x=(l+right)/2,y=(t+bottom)/2,hit=document.elementFromPoint(x,y)
    return hit&&(hit===el||el.contains(hit))&&(!pressable||hit.closest(selector)===el)&&(!overlay||overlay.contains(hit))?{x,y}:null
  }
  const foremost = () => [...document.querySelectorAll(overlays)].filter((el)=>visible(el)&&pointFor(el,null,false)).map((el,index)=>({el,index,focused:el.contains(document.activeElement),depth:(()=>{let n=0;for(let p=el.parentElement;p;p=p.parentElement)n++;return n})(),z:Number.parseInt(getComputedStyle(el).zIndex,10)||0})).sort((a,b)=>Number(b.focused)-Number(a.focused)||b.z-a.z||b.depth-a.depth||b.index-a.index)[0]?.el||null
  const label=(el)=>String(el.getAttribute('aria-label')||el.innerText||el.textContent||el.value||el.getAttribute('title')||el.tagName).trim().slice(0,160)
  const discover=(requestId)=>{ targets.clear();const found=[],overlay=foremost();for(const el of document.querySelectorAll(selector)){if(found.length>=80||!visible(el)||(overlay&&!overlay.contains(el)))continue;const point=pointFor(el,overlay);if(!point)continue;const id=String(++sequence);targets.set(id,{el,...point,overlay});found.push({id,label:label(el),...point})}send({type:'targets',requestId,targets:found}) }
  const watch=()=>{raf=0;if(!activeRequest)return;const overlay=foremost();for(const t of targets.values()){const p=visible(t.el)&&(!overlay||overlay.contains(t.el))?pointFor(t.el,overlay):null;if(!p||p.x!==t.x||p.y!==t.y||overlay!==t.overlay){invalidate();return}}raf=requestAnimationFrame(watch)}
  addEventListener('message',(event)=>{
    if(event.source!==parent||!event.data||event.data.nonce!==nonce)return
    const m=event.data
    if(m.type==='holi:vim-app-config'&&typeof m.enabled==='boolean'){enabled=m.enabled;if(!enabled)invalidate();return}
    if(m.type==='holi:vim-app-hints'&&typeof m.requestId==='string'&&m.requestId.length>0&&m.requestId.length<=100){invalidate();if(!enabled)return;activeRequest=m.requestId;discover(activeRequest);raf=requestAnimationFrame(watch);return}
    if(m.type==='cancel'&&m.requestId===activeRequest){invalidate();return}
    if(m.type!=='activate'||m.requestId!==activeRequest||typeof m.targetId!=='string')return
    const t=targets.get(m.targetId),overlay=foremost();if(!t||!visible(t.el)||overlay!==t.overlay||(overlay&&!overlay.contains(t.el))){invalidate();return}
    const p=pointFor(t.el,overlay);if(!p||p.x!==t.x||p.y!==t.y){invalidate();return}
    const el=t.el,hit=document.elementFromPoint(p.x,p.y);activeRequest='';targets.clear();if(raf)cancelAnimationFrame(raf);raf=0
    const init={bubbles:true,cancelable:true,clientX:p.x,clientY:p.y,button:0,buttons:1},ptr={...init,pointerId:1,pointerType:'mouse',isPrimary:true};activating=true
    try{const down=hit.dispatchEvent(new PointerEvent('pointerdown',ptr));if(!el.isConnected)return;let mouseDown=true;if(down){mouseDown=hit.dispatchEvent(new MouseEvent('mousedown',init));if(!el.isConnected)return;if(mouseDown&&(el instanceof HTMLElement||el instanceof SVGElement))el.focus({preventScroll:true});if(!el.isConnected)return}hit.dispatchEvent(new PointerEvent('pointerup',{...init,buttons:0,pointerId:1,pointerType:'mouse',isPrimary:true}));if(!el.isConnected)return;hit.dispatchEvent(new MouseEvent('mouseup',{...init,buttons:0}));if(el.isConnected)hit.dispatchEvent(new MouseEvent('click',{...init,buttons:0}))}finally{activating=false}
  })
  addEventListener('keydown',(e)=>{const modified=e.ctrlKey||e.altKey||e.metaKey;if(!activeRequest){if(enabled&&e.key.toLowerCase()==='f'&&!modified&&!e.shiftKey&&!e.repeat&&!e.isComposing&&!composing&&!editable(e.target)){e.preventDefault();e.stopImmediatePropagation();send({type:'request'})}return}const requestId=activeRequest;if(modified||e.shiftKey||e.isComposing||composing||editable(e.target)){invalidate();return}if(!/^[asdfghjklqwertyuiopzxcvbnm]$/.test(e.key)&&e.key!=='Backspace'&&e.key!=='Escape'){invalidate();return}e.preventDefault();e.stopImmediatePropagation();send({type:'key',requestId,key:e.key,shift:e.shiftKey,repeat:e.repeat,composing:e.isComposing||composing,modified})},true)
  addEventListener('keyup',(e)=>{if(activeRequest&&(e.shiftKey||e.ctrlKey||e.altKey||e.metaKey))invalidate()},true)
  addEventListener('compositionstart',()=>{composing=true;invalidate()},true);addEventListener('compositionend',()=>{composing=false},true)
  addEventListener('pointerdown',()=>{if(!activating)invalidate()},true);addEventListener('scroll',invalidate,true);addEventListener('resize',invalidate);addEventListener('blur',invalidate);addEventListener('focusin',()=>{if(!activating)invalidate()},true);addEventListener('pagehide',invalidate)
  new MutationObserver(()=>{if(!activating)invalidate()}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true})
})()`

/**
 * The runner document's own script, after the bridge: `holi.command(fn)`
 * registers the command, and the renderer's one `{ run: input }` runs it. The
 * answer goes back once, as `{ command: outcome }`; the renderer checks it
 * (`commandActionOf`), since it came out of the app's code.
 */
export const COMMAND_JS = `(() => {
  const nonce = document.querySelector('meta[name="holi-app-document-nonce"]')?.content
  if (!nonce) return
  let run = null
  window.holi.command = (fn) => { run = fn }
  const finish = (outcome) => parent.postMessage({ nonce, command: outcome }, '*')
  const announceReady = () => parent.postMessage({ nonce, ready: true }, '*')
  if (document.readyState === 'loading') {
    addEventListener('DOMContentLoaded', announceReady, { once: true })
  } else {
    announceReady()
  }
  addEventListener('message', async (e) => {
    if (e.source !== parent || !e.data || e.data.nonce !== nonce || typeof e.data.run !== 'object') return
    if (typeof run !== 'function') {
      finish({ ok: false, error: 'the script never called holi.command(fn)' })
      return
    }
    try {
      finish({ ok: true, value: await run(e.data.run) })
    } catch (err) {
      console.error(err)
      finish({ ok: false, error: String((err && err.message) || err) })
    }
  })
})()`
