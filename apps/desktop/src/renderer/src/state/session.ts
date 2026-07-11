import { atom } from 'jotai'
import type { PublicUser } from '../global'

/** null = signed out; undefined = not yet loaded. */
export const sessionAtom = atom<PublicUser | null | undefined>(undefined)

export const loadSessionAtom = atom(null, async (_get, set) => {
  set(sessionAtom, await window.holi.auth.get())
})

export const signOutAtom = atom(null, async (_get, set) => {
  await window.holi.auth.signOut()
  set(sessionAtom, null)
})
