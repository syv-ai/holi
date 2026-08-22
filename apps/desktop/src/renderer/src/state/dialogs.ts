import { atom } from 'jotai'
import type { CreateTaskMode } from './tasks'

/**
 * The dialog registry, as a discriminated union. A `*Dialog` feature dissolves
 * into a content block plus one entry here — `id` selects the block (Strategy
 * dispatch in DialogHost) and `size` is the guarded prop the shell reads. The
 * union grows one line per migrated dialog; that growth is the whole point.
 *
 * `closable` rides alongside the union rather than inside it: unlike `size` it
 * means the same thing for every dialog, and an entry sets it only to opt OUT —
 * which a block does when its own footer already offers a way out, since a
 * Cancel button beside a corner ✕ is two controls for one intent.
 */
export type ActiveDialog = { closable?: boolean } & (
  | { id: 'create-task'; size: 'md'; mode: CreateTaskMode }
  | { id: 'convert-to-pdf'; size: 'md'; remote: string; path: string }
  /**
   * A brand-new mail (D71). Carries no payload: a fresh message has nothing to
   * pass in, and `draftId` is deliberately absent — continuing an existing
   * draft happens in the Drafts view, which has the thread context this does
   * not.
   */
  | { id: 'compose-mail'; size: 'lg' }
  /**
   * Set or clear a path's icon in `.holi/icons.json` (D82). Carries the map's
   * current entry, which the tree already has, so the dialog opens filled in
   * rather than fetching it back.
   */
  | {
      id: 'edit-icon'
      size: 'sm'
      remote: string
      path: string
      current: string | null
      /** Opens `.holi/icons.json` itself. A closure, unlike every other field
       *  here, because opening a tab is the pane state's job and the tree is the
       *  only holder of that opener the summon passes through. */
      onOpenMap: () => void
    }
)

/** Null when nothing is open. Lives in the Jotai store, mounted once by the app
 *  shell — state passed through the store, not a global mutable singleton. */
export const activeDialogAtom = atom<ActiveDialog | null>(null)

export const openDialogAtom = atom(null, (_get, set, dialog: ActiveDialog) => {
  set(activeDialogAtom, dialog)
})

export const closeDialogAtom = atom(null, (_get, set) => {
  set(activeDialogAtom, null)
})
