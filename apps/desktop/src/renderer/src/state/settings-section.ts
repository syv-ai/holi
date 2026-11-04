/**
 * Where Settings is: its open section, and a request to bring it forward.
 *
 * **Shared, because the nav lives in the sidebar** while Settings is the tab
 * in front (docs/features/settings.md): the sidebar's nav and the tab's
 * content are two components that must agree on one section. `null` is the
 * first section.
 *
 * The shell owns its tabs, so opening Settings is a request it answers
 * (`settingsRequestAtom`): anything (a plugin's "Open Connections", the
 * profile menu, ⌘,) asks, and the shell adds or focuses the tab.
 */
import { atom } from 'jotai'
import { raise, requestAtom } from './request'

export const settingsSectionAtom = atom<string | null>(null)

/** Every request to show Settings; the shell answers it. */
export const settingsRequestAtom = requestAtom<object>()

/** Bring Settings forward on the section it was last on. */
export const openSettingsAtom = atom(null, (get, set) => {
  raise(get, set, settingsRequestAtom, {})
})

/** Open Settings at one section (Mail's and Calendar's "Open Connections",
 *  the profile menu's Preferences). */
export const openSettingsSectionAtom = atom(null, (get, set, section: string) => {
  set(settingsSectionAtom, section)
  raise(get, set, settingsRequestAtom, {})
})
