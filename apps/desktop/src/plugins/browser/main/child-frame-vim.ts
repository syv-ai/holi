import type { WebContents, WebFrameMain } from 'electron'
import { createFrameAddressing, type FrameAddress, type FrameCapture } from './frame-addressing'
import PAGE_SCRIPT from './page-script.js?raw'

type EditingState = { revision: number; mode: 'insert' | 'normal'; enabled: boolean }
type Child = {
  address: FrameAddress
  frame: WebFrameMain
  nonce: string
  focus: number
  unobserve?: () => void
  ready?: Promise<void>
}
type ModeSnapshot = EditingState & { current: () => boolean }

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
  let sampling: Promise<ModeSnapshot | null> | null = null

  const current = (owner: FrameCapture): boolean =>
    !disposed && owner === capture && enabled && !contents.isDestroyed() && presented()

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
        child.unobserve?.()
        pending.push(
          before
            .evaluate(
              child.address,
              `globalThis.__holiPage?.hints.reset(); globalThis.__holiPage?.vim.reset(${disabling}, globalThis.__holiPage.vim.documentNonce())`,
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
    if (requested !== revision || !next || disposed || contents.isDestroyed() || !presented())
      return
    enabled = true
    capture = Object.freeze({ tab, document: {}, presentation: {} })
  }

  async function prepare(frame: WebFrameMain, owner: FrameCapture) {
    const adapter = (addressing ??= createFrameAddressing(contents, current))
    const address = await adapter.resolve(frame, owner)
    if (!current(owner) || !adapter.isCurrent(address)) throw new Error('child world departed')
    let child = children.get(frame)
    if (!child || child.address !== address) {
      child = { frame, address, nonce: '', focus: 0 }
      children.set(frame, child)
      const bound = child
      child.ready = adapter
        .evaluate<string>(address, `${PAGE_SCRIPT}\n__holiPage.vim.armChild()`)
        .then((nonce) => {
          bound.nonce = nonce
        })
    }
    await child.ready
    if (!current(owner) || children.get(frame) !== child || !adapter.isCurrent(address))
      throw new Error('child world departed')
    return child
  }

  async function sample(): Promise<ModeSnapshot | null> {
    await draining
    const owner = capture
    if (!owner || !current(owner)) return null
    const frame = contents.focusedFrame
    if (!frame || frame === contents.mainFrame || frame.detached) return null
    const adapter = (addressing ??= createFrameAddressing(contents, current))
    const focused = (): boolean =>
      current(owner) && contents.focusedFrame === frame && !frame.detached
    try {
      const child = await prepare(frame, owner)
      const address = child.address
      if (!focused()) return null
      if (!child.unobserve) {
        const observed = child
        child.unobserve = await adapter.observeFocus(address, () => {
          observed.focus++
        })
      }
      const observed = child
      const tenure = child.focus
      const live = () =>
        focused() &&
        children.get(frame) === observed &&
        observed.focus === tenure &&
        adapter.isCurrent(address)
      if (!live()) return null
      let state = await adapter.evaluate<EditingState>(address, '__holiPage.vim.editingState()')
      if (!live()) return null
      if (!state.enabled) {
        const applied = await adapter.evaluate<boolean>(
          address,
          `document.hasFocus() && __holiPage.vim.configure(true, ${++revision}, ${JSON.stringify(child.nonce)})`,
        )
        if (!live() || !applied) return null
        state = await adapter.evaluate<EditingState>(address, '__holiPage.vim.editingState()')
      }
      return live() ? { ...state, current: live } : null
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

  async function hintWorlds(onlyFocused = false) {
    await draining
    const owner = capture
    if (!owner || !current(owner)) return []
    const adapter = (addressing ??= createFrameAddressing(contents, current))
    const frames = contents.mainFrame.frames
      .filter(
        (frame) =>
          !frame.detached &&
          /^https?:/i.test(frame.url) &&
          (!onlyFocused || frame === contents.focusedFrame),
      )
      .slice(0, 200)
    const worlds = []
    for (const frame of frames) {
      if (!current(owner)) break
      try {
        const child = await prepare(frame, owner)
        const address = child.address
        await adapter.projectDirectPoints(address, [])
        if (!current(owner) || !adapter.isCurrent(address)) continue
        const allowed = await adapter.evaluate<boolean>(
          address,
          '__holiPage.hints.enableChild(true)',
        )
        if (!allowed || !current(owner) || !adapter.isCurrent(address)) continue
        const bound = child
        worlds.push(
          Object.freeze({
            key: address,
            address,
            current: () =>
              current(owner) && children.get(frame) === bound && adapter.isCurrent(address),
            evaluate: <T>(expression: string) => adapter.evaluate<T>(address, expression),
            projectDirectPoints: (points: ReadonlyArray<{ x: number; y: number }>) =>
              adapter.projectDirectPoints(address, points),
            clickDirect: (
              point: { x: number; y: number },
              guard: () => boolean,
              expected?: { x: number; y: number },
            ) =>
              adapter.clickDirect(
                address,
                point,
                () => current(owner) && children.get(frame) === bound && guard(),
                expected,
              ),
          }),
        )
      } catch {
        const child = children.get(frame)
        if (child && adapter.isCurrent(child.address))
          await adapter
            .evaluate(child.address, '__holiPage.hints.enableChild(false)')
            .catch(() => {})
      }
    }
    return worlds
  }

  function mode(): Promise<ModeSnapshot | null> {
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

  return { configure, mode, hintWorlds, revoke, dispose }
}
