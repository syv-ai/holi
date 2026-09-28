import { atom } from 'jotai'
import type { CreateTaskMode } from './tasks'

/**
 * The dialog registry, as a discriminated union (`docs/ui-system.md`). A dialog
 * is a content block plus one entry here: `id` selects the block in DialogHost
 * and `size` is the guarded prop the shell reads.
 *
 * `closable` rides alongside the union: it means the same thing for every
 * dialog, and an entry sets it only to opt OUT, when its own footer already
 * offers a way out (a Cancel beside a corner ✕ is two controls for one intent).
 */
export type ActiveDialog = { closable?: boolean } & (
  | { id: 'create-task'; size: 'md'; mode: CreateTaskMode }
  | { id: 'convert-to-pdf'; size: 'md'; remote: string; path: string }
  /**
   * A brand-new mail (D71). Carries no payload, and `draftId` is deliberately
   * absent: continuing a draft happens in the Drafts view, which has the thread
   * context this does not.
   */
  | { id: 'compose-mail'; size: 'lg' }
  /**
   * Set or clear a path's icon in `.holi/settings/icons.yaml` (D82). Carries the
   * map's current entry, which the tree already has, so the dialog opens filled.
   */
  | {
      id: 'edit-icon'
      size: 'sm'
      remote: string
      path: string
      current: string | null
      /** Opens `.holi/settings/icons.yaml` itself. A closure, unlike every other
       *  field here, because the tree holds the opener. */
      onOpenMap: () => void
    }
  /** Opened from the vault picker and from Settings, for any registered vault,
   *  not only the open one. */
  | { id: 'remove-vault'; size: 'sm'; remote: string; intent: RemoveVaultIntent }
)

/** Leave a vault, delete it, or let go of one GitHub no longer shows (D109). */
export type RemoveVaultIntent = 'leave' | 'delete' | 'forget'

/** Null when nothing is open. The host is mounted once by the app shell. */
export const activeDialogAtom = atom<ActiveDialog | null>(null)

export const openDialogAtom = atom(null, (_get, set, dialog: ActiveDialog) => {
  set(activeDialogAtom, dialog)
})

export const closeDialogAtom = atom(null, (_get, set) => {
  set(activeDialogAtom, null)
})
