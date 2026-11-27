import { atom } from 'jotai'

/** Store-local invalidation for delayed navigation requests. */
export const navigationEpochAtom = atom(0)

export const advanceNavigationEpochAtom = atom(null, (_get, set) => {
  set(navigationEpochAtom, (epoch) => epoch + 1)
})
