import { atom } from 'jotai'
import type { PublicViewer } from '../../../main/router'
import { trpc } from '../lib/trpc'

/**
 * Who is signed in — `null` = signed out, `undefined` = not yet asked.
 *
 * Three values rather than two, because `App` renders nothing at all while it
 * is `undefined`: collapsing that into `null` would flash the sign-in screen at
 * every launch before the keychain answers, and collapsing it the other way
 * would leave the window blank forever on a machine that has never signed in.
 *
 * The type comes from `main/router` and is erased at compile time, exactly as
 * `AppRouter` is in `lib/ipc-link.ts` — no main-process module is bundled here.
 * There is no `PublicUser` any more; auth became GitHub identity in D60.
 */
export const sessionAtom = atom<PublicViewer | null | undefined>(undefined)

export const loadSessionAtom = atom(null, async (_get, set) => {
  const { viewer } = await trpc.auth.status.query()
  set(sessionAtom, viewer)
})

export const signOutAtom = atom(null, async (_get, set) => {
  // FR-15: this drops the keychain entry and leaves every clone where it is.
  // Removing a vault is a separate, deliberate act.
  await trpc.auth.signOut.mutate()
  set(sessionAtom, null)
})
