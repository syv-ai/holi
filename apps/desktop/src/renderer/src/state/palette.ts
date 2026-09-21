/**
 * The command palette's own state (D102). Not an entry in the form-dialog
 * registry (`state/dialogs.ts`): a palette is a different overlay class,
 * top-anchored and undimmed, and it is opened by keys that must work while a
 * form dialog is up.
 */
import { atom } from 'jotai'

/**
 * `open` is Quick Open, `commands` is the same box with `>` typed, `tabs` is
 * the ⌃⇥ switcher: the open tabs, most recent first, the current one left
 * out, held open while ⌃ is down.
 */
export type PaletteMode = 'open' | 'commands' | 'tabs'

export interface PaletteState {
  open: boolean
  /** What the list is over: everything (`open`, and `commands` once the query
   *  starts with `>`), or the open tabs. */
  mode: 'open' | 'tabs'
  /** The input's text. `>` at the front means command mode, as in VS Code. */
  query: string
  /** Bumped when ⌘P (or ⌃⇥) is pressed while already open: the component
   *  moves the selection, which is what VS Code does with a second ⌘P. */
  step: number
  stepDirection: 1 | -1
}

const CLOSED: PaletteState = { open: false, mode: 'open', query: '', step: 0, stepDirection: 1 }

export const paletteAtom = atom<PaletteState>(CLOSED)

export const COMMAND_PREFIX = '>'

/**
 * ⌘P and ⌘⇧P. Closed: open in the mode asked for. Already open: ⌘⇧P switches
 * the box to command mode, ⌘P steps the selection.
 */
export const openPaletteAtom = atom(null, (get, set, mode: PaletteMode): void => {
  const state = get(paletteAtom)
  if (!state.open) {
    set(paletteAtom, {
      ...CLOSED,
      open: true,
      mode: mode === 'tabs' ? 'tabs' : 'open',
      query: mode === 'commands' ? COMMAND_PREFIX : '',
    })
    return
  }
  if (mode === 'commands') {
    if (state.mode === 'tabs' || !state.query.startsWith(COMMAND_PREFIX))
      set(paletteAtom, { ...state, mode: 'open', query: COMMAND_PREFIX })
    return
  }
  set(paletteAtom, { ...state, step: state.step + 1, stepDirection: 1 })
})

/** ⇧⌃⇥: the switcher's selection moves up instead. */
export const stepPaletteBackAtom = atom(null, (get, set): void => {
  const state = get(paletteAtom)
  if (state.open) set(paletteAtom, { ...state, step: state.step + 1, stepDirection: -1 })
})

export const setPaletteQueryAtom = atom(null, (get, set, query: string): void => {
  set(paletteAtom, { ...get(paletteAtom), query })
})

export const closePaletteAtom = atom(null, (get, set): void => {
  const state = get(paletteAtom)
  if (state.open) set(paletteAtom, { ...state, open: false })
})
