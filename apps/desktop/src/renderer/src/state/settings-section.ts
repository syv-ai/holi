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

export const settingsSectionAtom = atom<string | null>(null)

/** Bumped on every request to show Settings; the shell watches it. */
export const settingsRequestAtom = atom(0)

/** Bring Settings forward on the section it was last on. */
export const openSettingsAtom = atom(null, (_get, set) => {
  set(settingsRequestAtom, (n) => n + 1)
})

/** Open Settings at one section (Mail's and Calendar's "Open Connections",
 *  the profile menu's Preferences). */
export const openSettingsSectionAtom = atom(null, (_get, set, section: string) => {
  set(settingsSectionAtom, section)
  set(settingsRequestAtom, (n) => n + 1)
})
