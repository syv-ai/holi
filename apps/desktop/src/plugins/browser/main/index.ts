/**
 * The browser's main side (docs/features/browser.md): its pages, laid over
 * their tabs in Holi's window, the capabilities behind the tab's controls
 * and `holi browser`, and the skill that teaches the agent to use them.
 *
 * Pages live while their vault is open: leaving it, or turning the plugin
 * off, closes them. The machine's logins outlive them (`pages.ts`).
 */
import type { MainPlugin } from '../../../main/plugin-api'
import { BROWSER_INFO } from '../info'
import { browserCapabilities, BROWSER_NAMESPACES, type Rect } from './capabilities'
import { browserSeed } from './seed'

const isRect = (r: unknown): r is Rect =>
  typeof r === 'object' &&
  r !== null &&
  ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((r as Record<string, unknown>)[k]))

export const browserMain: MainPlugin = {
  info: BROWSER_INFO,
  seed: browserSeed,
  async activate(ctx) {
    // A dynamic import keeps Electron out of what the tests load.
    const { createPages } = await import('./pages')
    const pages = createPages({
      window: () => ctx.window(),
      changed: (list) => ctx.emit(ctx.remote, 'tabs', list),
      reveal: (id) => ctx.emit(ctx.remote, 'reveal', { id }),
      address: (id) => ctx.emit(ctx.remote, 'address', { id }),
      key: (id, key) => ctx.emit(ctx.remote, 'key', { id, ...key }),
    })
    const undo = ctx.register(BROWSER_NAMESPACES, browserCapabilities(pages))
    // Where each tab is drawn, as the renderer lays it out: every frame it
    // moves, so a message rather than a capability call.
    const offPlace = ctx.on('place', (_remote, payload) => {
      if (typeof payload !== 'object' || payload === null) return
      const { id, rect } = payload as { id?: unknown; rect?: unknown }
      if (typeof id !== 'string') return
      pages.place(id, isRect(rect) ? rect : null)
    })
    return () => {
      offPlace()
      undo()
      pages.dispose()
    }
  },
}
