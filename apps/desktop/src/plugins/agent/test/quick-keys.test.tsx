/**
 * The quick agent's dock key in the main window, which answers it itself
 * because Holi holds it globally only while none of its windows has the
 * keyboard.
 */
import { createStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerDockKey, quickSettingsAtom } from '../renderer/quick/keys'
import type { QuickSettingsState } from '../shared/quick'

const SETTINGS: QuickSettingsState = {
  enabled: true,
  hotkey: '⌘J',
  conflict: false,
  dockHotkey: '⌃⌘J',
  dockConflict: false,
  autoApprove: false,
  instructions: false,
  accessibility: true,
}

/** The capabilities called, by name. */
let calls: string[] = []
let off: () => void = () => {}

beforeEach(() => {
  calls = []
  window.holi = {
    trpc: async (op: { path: string; input: { name: string } }) => {
      calls.push(op.input.name)
      return { ok: true, data: op.input.name === 'agent.quickSettings' ? SETTINGS : true }
    },
  } as never
})

afterEach(() => off())

/** The main window, with the vault open: its dock key read. */
async function mainWindow() {
  const store = createStore()
  off = answerDockKey('syv/vault', store)
  await vi.waitFor(() => expect(store.get(quickSettingsAtom)).not.toBeNull())
  return store
}

/** A key pressed in the page, where a terminal or the editor has focus. */
function press(init: KeyboardEventInit) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  document.body.dispatchEvent(e)
  return e
}

const DOCK_KEY = { key: 'j', code: 'KeyJ', ctrlKey: true, metaKey: true }

describe('the dock key in the main window', () => {
  it("opens the dock, ahead of the page's keys and of ⌘J's command", async () => {
    await mainWindow()
    // Core's command keys listen on the window, after the page's own.
    const command = vi.fn()
    window.addEventListener('keydown', command)
    try {
      const e = press(DOCK_KEY)
      expect(e.defaultPrevented).toBe(true)
      expect(command).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(calls).toContain('agent.quickDock'))
      // ⌘J alone is still the command's.
      press({ key: 'j', code: 'KeyJ', metaKey: true })
      expect(command).toHaveBeenCalledOnce()
      expect(calls.filter((c) => c === 'agent.quickDock')).toHaveLength(1)
    } finally {
      window.removeEventListener('keydown', command)
    }
  })

  it('answers the key Settings changed it to, and none while the keys are off', async () => {
    const store = await mainWindow()
    store.set(quickSettingsAtom, { ...SETTINGS, dockHotkey: '⌥Space' })
    expect(press(DOCK_KEY).defaultPrevented).toBe(false)
    expect(press({ key: ' ', code: 'Space', altKey: true }).defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(calls).toContain('agent.quickDock'))

    store.set(quickSettingsAtom, { ...SETTINGS, enabled: false })
    expect(press(DOCK_KEY).defaultPrevented).toBe(false)
  })

  it('leaves the key to Settings while it records one', async () => {
    await mainWindow()
    const record = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', record, true)
    try {
      press(DOCK_KEY)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(calls).not.toContain('agent.quickDock')
    } finally {
      window.removeEventListener('keydown', record, true)
    }
  })

  it('lets go of the key as the vault closes', async () => {
    await mainWindow()
    off()
    expect(press(DOCK_KEY).defaultPrevented).toBe(false)
  })
})
