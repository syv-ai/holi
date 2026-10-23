import { appModeAtom, type AppMode } from './app-mode'

/** The sidebar's two tabs. */
export type SidebarSection = AppMode

/** Which one shows: an atom rather than the sidebar's own state, so a
 *  shortcut can switch it (`lib/shortcuts.ts`). It is the app mode itself,
 *  so a plugin that brings the Agents mode forward (a chat it started, the
 *  agent's New session) switches the sidebar's tab with it. */
export const sidebarSectionAtom = appModeAtom
