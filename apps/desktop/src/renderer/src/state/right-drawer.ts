/**
 * The right edge holds one of core's drawers at a time: History, Links or
 * Comments. Opening one replaces whichever was open, so there is no stack of
 * hidden drawers to come back to.
 */
import { atom, type SetStateAction } from 'jotai'

export type RightDrawer = 'history' | 'links' | 'comments'

export const rightDrawerAtom = atom<RightDrawer | null>(null)

/** Whether `drawer` is the open one, as a boolean atom: true opens it in
 *  place of any other, false closes it if it is the one open. */
export function drawerOpenAtom(drawer: RightDrawer) {
  return atom(
    (get) => get(rightDrawerAtom) === drawer,
    (get, set, next: SetStateAction<boolean>) => {
      const open = get(rightDrawerAtom) === drawer
      const want = typeof next === 'function' ? next(open) : next
      if (want) set(rightDrawerAtom, drawer)
      else if (open) set(rightDrawerAtom, null)
    },
  )
}
