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
import {
  browserCapabilities,
  browserHintCapabilities,
  BROWSER_NAMESPACES,
  type Rect,
} from './capabilities'
import { browserSeed } from './seed'

const combineLeases =
  (presentation: () => boolean, attachment?: () => boolean): (() => boolean) =>
  () =>
    presentation() && (attachment === undefined || attachment())

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
      presentationLease: () => ctx.presentationLease(),
      onDisplayChange: (cb) => ctx.onDisplayChange(cb),
      changed: (list) => ctx.emit(ctx.remote, 'tabs', list),
      reveal: (id, attachment) =>
        ctx.emit(ctx.remote, 'reveal', { id }, combineLeases(ctx.presentationLease(), attachment)),
      address: (id, attachment) =>
        ctx.emit(ctx.remote, 'address', { id }, combineLeases(ctx.presentationLease(), attachment)),
      key: (id, key, attachment) =>
        ctx.emit(
          ctx.remote,
          'key',
          { id, ...key },
          combineLeases(ctx.presentationLease(), attachment),
        ),
      vimMode: (id, snapshot, attachment) =>
        ctx.emit(
          ctx.remote,
          'vim-mode',
          { id, ...snapshot },
          combineLeases(ctx.presentationLease(), attachment),
        ),
      hints: (event, attachment) =>
        ctx.emit(ctx.remote, 'hints', event, combineLeases(ctx.presentationLease(), attachment)),
    })
    const undo = ctx.register(BROWSER_NAMESPACES, {
      ...browserCapabilities(pages),
      ...browserHintCapabilities(pages),
    })
    // Where each tab is drawn, as the renderer lays it out: every frame it
    // moves, so a message rather than a capability call.
    const offPlace = ctx.on(
      'place',
      (_remote, payload) => {
        if (typeof payload !== 'object' || payload === null) return
        const { id, rect } = payload as { id?: unknown; rect?: unknown }
        if (typeof id !== 'string') return
        pages.place(id, isRect(rect) ? rect : null)
      },
      (_remote, payload) => {
        const id =
          typeof payload === 'object' && payload !== null
            ? (payload as { id?: unknown }).id
            : undefined
        return pages.placementGuard(id, ctx.presentationLease())
      },
    )
    const offVim = ctx.on(
      'vim-config',
      (_remote, payload) => {
        if (typeof payload !== 'object' || payload === null) return
        const value = payload as {
          id?: unknown
          enabled?: unknown
          revision?: unknown
          nonce?: unknown
          attachment?: unknown
        }
        if (
          typeof value.id !== 'string' ||
          typeof value.enabled !== 'boolean' ||
          !Number.isSafeInteger(value.revision) ||
          typeof value.nonce !== 'string' ||
          value.nonce.length > 128 ||
          typeof value.attachment !== 'string' ||
          value.attachment.length > 128
        )
          return
        void pages.configureVim(
          value.id,
          value.enabled,
          value.revision as number,
          value.nonce,
          value.attachment,
        )
      },
      (_remote, payload) => {
        const id =
          typeof payload === 'object' && payload !== null
            ? (payload as { id?: unknown }).id
            : undefined
        return pages.placementGuard(id, ctx.presentationLease())
      },
    )
    return () => {
      offPlace()
      offVim()
      undo()
      pages.dispose()
    }
  },
}
