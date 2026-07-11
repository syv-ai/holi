import { useAtomValue, useSetAtom } from 'jotai'
import { sessionAtom, signOutAtom } from '../state/session'

export function Shell() {
  const session = useAtomValue(sessionAtom)
  const signOut = useSetAtom(signOutAtom)
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-neutral-950 text-neutral-100">
      <p className="text-sm">signed in as {session?.email}</p>
      <button className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700" onClick={() => void signOut()}>
        sign out
      </button>
    </div>
  )
}
