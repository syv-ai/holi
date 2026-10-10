/**
 * The quick agent's keys in the main window (docs/features/quick-agent.md).
 * Holi holds them globally only while none of its windows has the keyboard,
 * so inside the main window it answers them itself: the hotkey keeps its
 * in-app meaning (⌘J opens the agents, a command of the plugin's), and the
 * dock's key opens the dock with the keyboard, as it does from any other app.
 */
import { atom } from 'jotai'
import { hotkeyFromEvent } from '../../shared/hotkey'
import type { QuickSettingsState } from '../../shared/quick'
import { quickCap } from '../quick-cap'
import type { PluginStore } from '@/plugin-api'

/** This machine's quick agent settings as last read: the settings section
 *  shows and changes them, and the dock's key is answered from them. Null
 *  until read, or when the quick agent is not running. */
export const quickSettingsAtom = atom<QuickSettingsState | null>(null)

/**
 * While `remote` is the open vault: the dock's key opens the dock. Read on
 * the document in the capture phase, ahead of the page's own keys (the
 * terminal and the editor would take it, and ⌃⌘J would run ⌘J's command,
 * since an in-app hotkey reads ⌃ as ⌘), and behind a key being recorded in
 * Settings, which listens on the window and stops it there.
 */
export function answerDockKey(remote: string, store: PluginStore): () => void {
  let live = true
  const load = (): void =>
    void quickCap.quickSettings(remote).then(
      (settings) => {
        if (live) store.set(quickSettingsAtom, settings)
      },
      () => {},
    )
  load()
  // Changed while another window had the keyboard, or by hand: read again as
  // this one gets it back.
  window.addEventListener('focus', load)

  const onKey = (e: KeyboardEvent): void => {
    const settings = store.get(quickSettingsAtom)
    if (settings === null || !settings.enabled || e.isComposing) return
    if (hotkeyFromEvent(e) !== settings.dockHotkey) return
    e.preventDefault()
    e.stopPropagation()
    if (!e.repeat) void quickCap.quickDock(remote).catch(() => {})
  }
  document.addEventListener('keydown', onKey, true)

  return () => {
    live = false
    window.removeEventListener('focus', load)
    document.removeEventListener('keydown', onKey, true)
  }
}
