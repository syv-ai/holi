import { atom } from 'jotai'
import type { CreateTaskMode } from './tasks'

/**
 * The dialog registry, as a discriminated union. A `*Dialog` feature dissolves
 * into a content block plus one entry here — `id` selects the block (Strategy
 * dispatch in DialogHost) and `size` is the guarded prop the shell reads. The
 * union grows one line per migrated dialog; that growth is the whole point.
 */
export type ActiveDialog = { id: 'create-task'; size: 'md'; mode: CreateTaskMode }

/** Null when nothing is open. Lives in the Jotai store, mounted once by the app
 *  shell — state passed through the store, not a global mutable singleton. */
export const activeDialogAtom = atom<ActiveDialog | null>(null)

export const openDialogAtom = atom(null, (_get, set, dialog: ActiveDialog) => {
  set(activeDialogAtom, dialog)
})

export const closeDialogAtom = atom(null, (_get, set) => {
  set(activeDialogAtom, null)
})
