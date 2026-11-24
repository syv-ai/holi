import type { WebContents, WebFrameMain } from 'electron'
import { createFrameAddressing, type FrameAddress, type FrameCapture } from './frame-addressing'
import PAGE_SCRIPT from './page-script.js?raw'

type EditingState = { revision: number; mode: 'insert' | 'normal'; enabled: boolean }
type Child = { address: FrameAddress; frame: WebFrameMain; nonce: string }

/** Owns editing-only child worlds; frame and protocol identities never leave main. */
export function createChildFrameVim(
  contents: WebContents,
  presented: () => boolean,
  releaseFocus: () => void,
) {
  const tab = {}
  let capture: FrameCapture | null = null
  let addressing: ReturnType<typeof createFrameAddressing> | null = null
  const children = new Map<WebFrameMain, Child>()
  let enabled = false
  let revision = 0
  let disposed = false
  let draining: Promise<void> = Promise.resolve()
  let sampling: Promise<EditingState | null> | null = null

  const current = (owner: FrameCapture): boolean =>
    !disposed && owner === capture && enabled && presented() && !contents.isDestroyed()

  function revoke(blur = false): Promise<void> {
    if (blur && children.size > 0 && !contents.isDestroyed()) releaseFocus()
    // evaluate dispatches synchronously before its first await. Send the disabling
    // revision before retiring addresses, including worlds whose initialization
    // was dispatched but whose nonce has not yet returned.
    const before = addressing
    const disabling = ++revision
    const pending: Promise<unknown>[] = [draining]
    if (before) {
      for (const child of children.values()) {
        pending.push(
          before
            .evaluate(
              child.address,
              `globalThis.__holiPage?.vim.reset(${disabling}, globalThis.__holiPage.vim.documentNonce())`,
            )
            .catch(() => {}),
        )
      }
    }
    enabled = false
    const previous = capture
    capture = null
    sampling = null
    children.clear()
    if (previous) before?.revoke(previous)
    draining = Promise.allSettled(pending).then(() => {})
    return draining
  }

  async function configure(next: boolean): Promise<void> {
    const settled = revoke()
    const requested = revision
    await settled
    if (requested !== revision || !next || disposed || !presented() || contents.isDestroyed())
      return
    enabled = true
    capture = Object.freeze({ tab, document: {}, presentation: {} })
    addressing ??= createFrameAddressing(contents, current)
  }

  async function sample(): Promise<EditingState | null> {
    await draining
    const owner = capture
    const adapter = addressing
    if (!owner || !adapter || !current(owner)) return null
    const frame = contents.focusedFrame
    if (!frame || frame === contents.mainFrame || frame.detached) return null
    const focused = (): boolean =>
      current(owner) && contents.focusedFrame === frame && !frame.detached
    try {
      const address = await adapter.resolve(frame, owner)
      if (!focused()) return null
      let child = children.get(frame)
      if (!child || child.address !== address) {
        // Remember the address before dispatch so revoke can disable a pending
        // initialization without waiting for its nonce to return.
        child = { frame, address, nonce: '' }
        children.set(frame, child)
        const nonce = await adapter.evaluate<string>(
          address,
          `${PAGE_SCRIPT}\n__holiPage.vim.armChild()`,
        )
        if (!focused() || children.get(frame) !== child) return null
        child.nonce = nonce
      }
      const state = await adapter.evaluate<EditingState>(address, '__holiPage.vim.editingState()')
      if (!focused()) return null
      if (!state.enabled) {
        const applied = await adapter.evaluate<boolean>(
          address,
          `document.hasFocus() && __holiPage.vim.configure(true, ${++revision}, ${JSON.stringify(child.nonce)})`,
        )
        if (!focused() || !applied) return null
      }
      const result = await adapter.evaluate<EditingState>(address, '__holiPage.vim.editingState()')
      return focused() ? result : null
    } catch {
      // A document can depart while resolving its native ownership. Do not use a
      // cached mode or a guessed frame after an addressing failure.
      if (current(owner)) {
        revoke(true)
        adapter.dispose()
        if (addressing === adapter) addressing = null
      }
      return null
    }
  }

  function mode(): Promise<EditingState | null> {
    if (sampling) return sampling
    const pending = sample()
    sampling = pending
    const clear = () => {
      if (sampling === pending) sampling = null
    }
    void pending.then(clear, clear)
    return pending
  }

  function dispose(): void {
    revoke()
    disposed = true
    addressing?.dispose()
    addressing = null
  }

  return { configure, mode, revoke, dispose }
}
