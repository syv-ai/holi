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
 * objects never meet; the shared name is a coincidence of both being "the way
 * out of this document".
 *
 * `postMessage(..., '*')` is correct rather than lazy: the frame's origin is
 * opaque, so there is no origin string it could target instead. Identity is
 * verified on the other side, by the renderer, which knows which frame it
 * mounted and therefore which app is speaking.
 */
export const BRIDGE_JS = `(() => {
  const pending = new Map()
  addEventListener('message', (e) => {
    if (e.source !== parent) return
    const msg = e.data
    if (!msg || typeof msg.id !== 'string') return
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.ok) entry.resolve(msg.value)
    else entry.reject(new Error(String(msg.error)))
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      pending.set(id, { resolve, reject })
      parent.postMessage({ id, method, params }, '*')
    })
  window.holi = {
    docs: {
      list: () => call('docs.list'),
      read: (path) => call('docs.read', { path }),
    },
    tasks: {
      list: () => call('tasks.list'),
    },
    open: (path) => call('open', { path }),
  }
})()`
