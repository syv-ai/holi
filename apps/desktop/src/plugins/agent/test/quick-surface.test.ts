/**
 * A quick panel's window over a fake of Electron's: which of its blurs are a
 * person's, the ones that put an agent's panel away.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { AppContext } from '../../../main/plugin-api'
import { electronSurface } from '../main/quick/surface'

/** Electron's window as far as the surface uses it. Focus and blur are
 *  emitted as the window gains and loses the keyboard. */
function fakeWindow() {
  const events = new EventEmitter()
  const at = { visible: false, focused: false }
  /** The keyboard goes elsewhere. */
  const blur = (): void => {
    if (!at.focused) return
    at.focused = false
    events.emit('blur')
  }
  return {
    on: (name: string, cb: () => void) => void events.on(name, cb),
    setAlwaysOnTop: () => {},
    setVisibleOnAllWorkspaces: () => {},
    setHiddenInMissionControl: () => {},
    isDestroyed: () => false,
    isVisible: () => at.visible,
    isFocused: () => at.focused,
    getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    setBounds: () => {},
    destroy: () => {},
    show: () => void (at.visible = true),
    showInactive: () => void (at.visible = true),
    focus() {
      if (at.focused) return
      at.focused = true
      events.emit('focus')
    },
    hide() {
      at.visible = false
      blur()
    },
    blur,
  }
}

function rig() {
  const win = fakeWindow()
  const sent: Array<[string, unknown]> = []
  const ctx = {
    openPage: () => ({
      window: win,
      send: (name: string, payload: unknown) => void sent.push([name, payload]),
      on: () => () => {},
    }),
  } as unknown as AppContext
  const surface = electronSurface(ctx)
  const onUserBlur = vi.fn()
  surface.onUserBlur(onUserBlur)
  return { win, sent, surface, onUserBlur }
}

describe("a quick panel's window", () => {
  it('does not count the blur its own hide causes as a person taking the keyboard', () => {
    const { sent, surface, onUserBlur } = rig()
    surface.show(true)
    surface.hide()
    expect(onUserBlur).not.toHaveBeenCalled()
    expect(sent).toContainEqual(['quick-focus', { focused: false, user: false }])
  })

  it('counts a blur after it is shown again as a person taking the keyboard, however soon', () => {
    const { win, sent, surface, onUserBlur } = rig()
    // ↓ then ↑ in the dock: hidden, and back with the keyboard at once.
    surface.show(true)
    surface.hide()
    surface.show(true)
    // The person clicks into another app straight away.
    win.blur()
    expect(onUserBlur).toHaveBeenCalledOnce()
    expect(sent.at(-1)).toEqual(['quick-focus', { focused: false, user: true }])
  })
})
