/**
 * The open vault's people, by GitHub login: who a task can be assigned to
 * (docs/features/tasks.md, Assignees).
 *
 * Main's collaborator list (ten-minute cache, `github/members-cache.ts`),
 * plus the signed-in login and every login a task already names. The extras
 * matter offline and on a vault GitHub will not list collaborators for: the
 * person themselves, and anyone the vault already assigns, are always offered.
 *
 * Vault-scoped and loaded once in Shell (`useVaultMembers`), never by
 * whichever view asks first.
 */
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { trpc } from '@/lib/trpc'
import { sessionAtom } from './session'
import { snapshotTasksAtom } from './tasks'
import { activeRemoteAtom } from './vaults'

export interface Member {
  login: string
  avatarUrl?: string
}

/** GitHub's answer for one vault, or null before it came (or when it failed). */
const fetchedMembersAtom = atom<{ remote: string; members: Member[] } | null>(null)

/** Everyone a task in the open vault can name, sorted, the signed-in person
 *  first. */
export const vaultMembersAtom = atom((get): Member[] => {
  const remote = get(activeRemoteAtom)
  const fetched = get(fetchedMembersAtom)
  const me = get(sessionAtom)?.login ?? null
  const byLogin = new Map<string, Member>()
  const add = (m: Member): void => {
    const key = m.login.toLowerCase()
    const known = byLogin.get(key)
    if (known === undefined || (known.avatarUrl === undefined && m.avatarUrl !== undefined)) {
      byLogin.set(key, m)
    }
  }
  if (fetched !== null && fetched.remote === remote) fetched.members.forEach(add)
  if (me !== null) add({ login: me })
  for (const task of get(snapshotTasksAtom).items) {
    for (const login of task.assignees ?? []) add({ login })
  }
  const mine = me?.toLowerCase()
  return [...byLogin.values()].sort((a, b) =>
    a.login.toLowerCase() === mine
      ? -1
      : b.login.toLowerCase() === mine
        ? 1
        : a.login.localeCompare(b.login, undefined, { sensitivity: 'base' }),
  )
})

/** The logins alone, for a chip field's suggestions. */
export const memberLoginsAtom = atom((get) => get(vaultMembersAtom).map((m) => m.login))

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
        if (!live) return
        setFetched({
          remote,
          members: collaborators.map((c) => ({
            login: c.login,
            ...(c.avatarUrl === undefined ? {} : { avatarUrl: c.avatarUrl }),
          })),
        })
      })
      .catch((err: unknown) => console.warn('[members] not listed:', err))
    return () => {
      live = false
    }
  }, [remote, setFetched])
}
