import { atom } from 'jotai'

/** The sidebar's two tabs. */
export type SidebarSection = 'documents' | 'agents'

/** Which one shows: an atom rather than the sidebar's own state, so a
 *  shortcut can switch it (`lib/shortcuts.ts`). */
export const sidebarSectionAtom = atom<SidebarSection>('documents')
