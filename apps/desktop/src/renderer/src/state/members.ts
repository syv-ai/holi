/** Vault membership — thin over the server, which owns every rule (roles, last-owner,
 * the personal-vault block). The client's job is to show who has access and not to offer
 * controls the server will refuse. */
import { atom } from 'jotai'
import type { Role, Vault } from '@holi/shared'
import { trpc } from '../lib/trpc'
import { activeVaultIdAtom, vaultsAtom } from './vaults'

export interface Member {
  userId: string
  role: Role
  email: string
  name: string | null
  avatarUrl: string | null
}

/** Someone invited who has never signed in: the server holds a `pending:` stub user for
 * them, claimed by email on their first sign-in. They have a row and access already —
 * they just haven't shown up. Worth saying so, rather than rendering a nameless line. */
export const isPendingInvite = (m: Member): boolean => m.name === null

/** What to call a member in the list. Email is the identity here — names arrive from
 * Google on first sign-in, so a pending invitee has only ever given us an address. */
export const memberLabel = (m: Member): string => m.name ?? m.email

export const membersAtom = atom<Member[]>([])

/** The active vault, when it is one you can actually share. Membership is a shared-vault
 * concept (auth-identity FR-14) — mirrors the server's hard block (D49), so the panel
 * never offers an action that would be refused. */
export const shareableVaultAtom = atom<Vault | null>((get) => {
  const vaultId = get(activeVaultIdAtom)
  const vault = get(vaultsAtom).find((v) => v.id === vaultId)
  return vault?.kind === 'shared' ? vault : null
})

export const loadMembersAtom = atom(null, async (get, set) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  set(membersAtom, (await trpc.membership.list.query({ vaultId })) as Member[])
})

const withVault = <A extends unknown[]>(fn: (vaultId: string, ...args: A) => Promise<unknown>) =>
  atom(null, async (get, set, ...args: A) => {
    const vaultId = get(activeVaultIdAtom)
    if (!vaultId) return
    await fn(vaultId, ...args)
    // Refetch rather than patch: roles interlock (a transfer moves two rows at once), and
    // the server is the only thing that knows the result.
    await set(loadMembersAtom)
  })

export const inviteMemberAtom = withVault((vaultId, email: string, role: Role) =>
  trpc.membership.invite.mutate({ vaultId, email, role }),
)
export const setMemberRoleAtom = withVault((vaultId, userId: string, role: Role) =>
  trpc.membership.setRole.mutate({ vaultId, userId, role }),
)
export const removeMemberAtom = withVault((vaultId, userId: string) =>
  trpc.membership.remove.mutate({ vaultId, userId }),
)
export const transferOwnershipAtom = withVault((vaultId, toUserId: string) =>
  trpc.membership.transferOwnership.mutate({ vaultId, toUserId }),
)

/** Leaving drops the vault from your list entirely, so the caller reloads vaults, not
 * members — there is no membership list left for you to read. */
export const leaveVaultAtom = atom(null, async (get) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  await trpc.membership.leave.mutate({ vaultId })
})
