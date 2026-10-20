/**
 * Where the Settings tab is: its open section, and a heading to scroll to.
 *
 * **Shared, because the rail lives in the sidebar** while Settings is the tab
 * in front (docs/features/settings.md): the sidebar's rail and the tab's
 * content are two components that must agree on one section. `null` is the
 * first section.
 */
import { atom } from 'jotai'
import { openSurface, workspaceAtom } from './panes'

export const settingsSectionAtom = atom<string | null>(null)

/** A heading the rail asked the content to scroll to; `n` makes a repeat a
 *  new request. Taken by the content, which owns the scroller. */
export const settingsJumpAtom = atom<{ id: string; n: number } | null>(null)

/** Open Settings at one section (the profile menu's Sign out goes to Account). */
export const openSettingsSectionAtom = atom(null, (_get, set, section: string) => {
  set(settingsSectionAtom, section)
  set(workspaceAtom, (w) => openSurface(w, 'settings'))
})
