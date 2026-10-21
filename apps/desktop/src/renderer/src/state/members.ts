/**
 * The open vault's people, by GitHub login: who a `people` field can name,
 * such as a task's assignees (docs/features/tasks.md, Assignees).
 *
 * Main's collaborator list (ten-minute cache, `github/members-cache.ts`),
 * plus the signed-in login. The extra matters offline and on a vault GitHub
 * will not list collaborators for: the person themselves is always offered.
 * A plugin adds whoever its files already name.
 *
 * Vault-scoped and loaded once in Shell (`useVaultMembers`), never by
 * whichever view asks first.
 */
import { cleanLogins, sameLogin } from '@holi/shared'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { trpc } from '@/lib/trpc'
import { sessionAtom } from './session'
import { activeRemoteAtom } from './vaults'

/** GitHub's answer for one vault, or null before it came (or when it failed). */
const fetchedMembersAtom = atom<{ remote: string; logins: string[] } | null>(null)

/** Logins as a list of people to show: each once, the signed-in person
 *  (`me`) first, then the rest by name. */
export function peopleList(logins: Iterable<string>, me: string | null): string[] {
  const isMe = (login: string) => me !== null && sameLogin(login, me)
  return cleanLogins(logins).sort((a, b) =>
    isMe(a) ? -1 : isMe(b) ? 1 : a.localeCompare(b, undefined, { sensitivity: 'base' }),
  )
}

/** Everyone the open vault's people fields can name, the signed-in person
 *  first. */
export const memberLoginsAtom = atom((get): string[] => {
  const remote = get(activeRemoteAtom)
  const fetched = get(fetchedMembersAtom)
  const me = get(sessionAtom)?.login ?? null
  return peopleList(
    [
      ...(fetched !== null && fetched.remote === remote ? fetched.logins : []),
      ...(me === null ? [] : [me]),
    ],
    me,
  )
})

/** Ask main for the open vault's collaborators whenever the vault changes.
 *  Mounted once, in Shell. A refusal (offline, not listable) leaves the
 *  extras, which is the most that can be known. */
export function useVaultMembers(): void {
  const remote = useAtomValue(activeRemoteAtom)
  const setFetched = useSetAtom(fetchedMembersAtom)
  useEffect(() => {
    if (remote === null) return
    let live = true
    trpc.github.collaborators
      .query({ remote })
      .then(({ collaborators }) => {
        if (live) setFetched({ remote, logins: collaborators.map((c) => c.login) })
      })
      .catch((err: unknown) => console.warn('[members] not listed:', err))
    return () => {
      live = false
    }
  }, [remote, setFetched])
}
