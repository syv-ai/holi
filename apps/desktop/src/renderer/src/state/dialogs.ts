import { atom } from 'jotai'
import type { ReactNode } from 'react'

/** How wide a plugin's dialog asks to be; the host maps it to the stock dialog's width. */
export type DialogSize = 'sm' | 'md' | 'lg' | 'full' | 'bare'

/**
 * The dialog that can be asked for: a plugin's, at the width `size` asks for.
 * `openDialogAtom` records the ask in `activeDialogAtom`, and the shell's
 * `DialogHost` draws it. `id` stays so a core dialog can join as a union.
 *
 * `closable` is set only to opt OUT, when the dialog's own footer already
 * offers a way out (a Cancel beside a corner ✕ is two controls for one intent).
 */
export type ActiveDialog = { closable?: boolean } & {
  /**
   * A plugin's dialog. Core knows nothing of its content: the plugin renders
   * it, and calls `close` when it is done.
   */
  id: 'plugin'
  size: DialogSize
  render: (close: () => void) => ReactNode
}

/** The one dialog a plugin may open. */
export type PluginDialog = ActiveDialog

/** Null when nothing is open. */
const activeDialogAtom = atom<ActiveDialog | null>(null)

/** The dialog asked for, for the host to draw. */
export const shownDialogAtom = atom((get) => get(activeDialogAtom))

/** Close whatever dialog is open. */
export const closeDialogAtom = atom(null, (_get, set) => {
  set(activeDialogAtom, null)
})

export const openDialogAtom = atom(null, (_get, set, dialog: ActiveDialog) => {
  set(activeDialogAtom, dialog)
})
