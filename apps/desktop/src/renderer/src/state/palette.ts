/**
 * The command palette's own state (D102). Not an entry in the form-dialog
 * registry (`state/dialogs.ts`): a palette is a different overlay class,
 * top-anchored and undimmed, and it is opened by keys that must work while a
 * form dialog is up.
 */
import { atom } from 'jotai'

export type PaletteMode = 'open' | 'commands'

export interface PaletteState {
  open: boolean
  /** The input's text. `>` at the front means command mode, as in VS Code. */
  query: string
  /** Bumped when ⌘P is pressed while already open: the component moves the
   *  selection down, which is what VS Code does with a second ⌘P. */
  step: number
}

export const paletteAtom = atom<PaletteState>({ open: false, query: '', step: 0 })

export const COMMAND_PREFIX = '>'

/**
 * ⌘P and ⌘⇧P. Closed: open in the mode asked for. Already open: ⌘⇧P switches
 * the box to command mode, ⌘P steps the selection.
 */
export const openPaletteAtom = atom(null, (get, set, mode: PaletteMode): void => {
  const state = get(paletteAtom)
  if (!state.open) {
    set(paletteAtom, { open: true, query: mode === 'commands' ? COMMAND_PREFIX : '', step: 0 })
    return
  }
  if (mode === 'commands') {
    if (!state.query.startsWith(COMMAND_PREFIX))
      set(paletteAtom, { ...state, query: COMMAND_PREFIX })
    return
  }
  set(paletteAtom, { ...state, step: state.step + 1 })
})

export const setPaletteQueryAtom = atom(null, (get, set, query: string): void => {
  set(paletteAtom, { ...get(paletteAtom), query })
})

export const closePaletteAtom = atom(null, (get, set): void => {
  const state = get(paletteAtom)
  if (state.open) set(paletteAtom, { ...state, open: false })
})
