import { atom } from 'jotai'
import type { CreateTaskMode } from './tasks'

/**
 * The dialog registry, as a discriminated union. A `*Dialog` feature dissolves
 * into a content block plus one entry here — `id` selects the block (Strategy
 * dispatch in DialogHost) and `size` is the guarded prop the shell reads. The
 * union grows one line per migrated dialog; that growth is the whole point.
 */
export type ActiveDialog =
  | { id: 'create-task'; size: 'md'; mode: CreateTaskMode }
  | { id: 'convert-to-pdf'; size: 'md'; remote: string; path: string }
  /**
   * A brand-new mail (D71). Carries no payload: a fresh message has nothing to
   * pass in, and `draftId` is deliberately absent — continuing an existing
   * draft happens in the Drafts view, which has the thread context this does
   * not.
   */
  | { id: 'compose-mail'; size: 'lg' }

/** Null when nothing is open. Lives in the Jotai store, mounted once by the app
 *  shell — state passed through the store, not a global mutable singleton. */
export const activeDialogAtom = atom<ActiveDialog | null>(null)

export const openDialogAtom = atom(null, (_get, set, dialog: ActiveDialog) => {
  set(activeDialogAtom, dialog)
})

export const closeDialogAtom = atom(null, (_get, set) => {
  set(activeDialogAtom, null)
})
