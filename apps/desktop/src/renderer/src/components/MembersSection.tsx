/**
 * Who has access to this vault — the door into the collaboration engine.
 *
 * Renders only for a shared vault: membership is a shared-vault concept (auth-identity
 * FR-14), mirroring the server's hard block (D49) rather than duplicating its reasoning.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import type { Role } from '@holi/shared'
import {
  inviteMemberAtom,
  isPendingInvite,
  leaveVaultAtom,
  loadMembersAtom,
  memberLabel,
  membersAtom,
  removeMemberAtom,
  setMemberRoleAtom,
  shareableVaultAtom,
  transferOwnershipAtom,
  type Member,
} from '../state/members'
import { sessionAtom } from '../state/session'
import { loadVaultsAtom } from '../state/vaults'

export function MembersSection({ guard, busy }: { guard: (fn: () => Promise<unknown>) => () => Promise<void>; busy: boolean }) {
  const vault = useAtomValue(shareableVaultAtom)
  const members = useAtomValue(membersAtom)
  const session = useAtomValue(sessionAtom)
  const load = useSetAtom(loadMembersAtom)
  const invite = useSetAtom(inviteMemberAtom)
  const setRole = useSetAtom(setMemberRoleAtom)
  const remove = useSetAtom(removeMemberAtom)
  const transfer = useSetAtom(transferOwnershipAtom)
  const leave = useSetAtom(leaveVaultAtom)
  const loadVaults = useSetAtom(loadVaultsAtom)
  const [email, setEmail] = useState('')
  const [role, setRoleChoice] = useState<Role>('member')

  useEffect(() => {
    if (vault) void load()
  }, [vault, load])

  // A personal vault has exactly one member and cannot gain another — there is nothing
  // here to show, and the server would refuse every control anyway.
  if (!vault) return null

  const me = members.find((m) => m.userId === session?.userId)
  const isOwner = me?.role === 'owner'

  return (
    <section className="space-y-2">
      <h3 className="font-medium">Members</h3>

      <ul className="divide-y divide-neutral-900 rounded border border-neutral-900">
        {members.map((m) => (
          <MemberRow
            key={m.userId}
            member={m}
            isSelf={m.userId === session?.userId}
            canManage={isOwner}
            busy={busy}
            onRole={guard(() => setRole(m.userId, m.role === 'owner' ? 'member' : 'owner'))}
            onRemove={guard(async () => {
              if (!confirm(`Remove ${memberLabel(m)} from ${vault.name}?`)) return
              await remove(m.userId)
            })}
            onTransfer={guard(async () => {
              if (!confirm(`Make ${memberLabel(m)} the owner of ${vault.name}? You become a member. This cannot be undone from here.`)) return
              await transfer(m.userId)
            })}
          />
        ))}
      </ul>

      {isOwner ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const trimmed = email.trim()
            if (!trimmed) return
            void guard(async () => {
              await invite(trimmed, role)
              setEmail('')
            })()
          }}
        >
          <input
            className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
            placeholder="teammate@syv.ai"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {/* Default member, per FR-10 — owner is a deliberate choice, not a slip. */}
          <select
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
            value={role}
            onChange={(e) => setRoleChoice(e.target.value as Role)}
          >
            <option value="member">member</option>
            <option value="owner">owner</option>
          </select>
          <button
            disabled={busy}
            className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700 disabled:opacity-50"
          >
            Invite
          </button>
        </form>
      ) : (
        // Not a read-only tier — everyone here can edit everything. Only vault
        // administration is the owner's, and offering a control that always 403s is
        // worse than not offering it.
        <p className="text-xs text-neutral-500">Only an owner can invite or remove members.</p>
      )}

      {me && !isOwner && (
        <button
          disabled={busy}
          className="rounded px-1 text-xs text-red-400 hover:bg-neutral-900 disabled:opacity-50"
          onClick={guard(async () => {
            if (!confirm(`Leave ${vault.name}? You lose access until someone invites you back.`)) return
            await leave()
            await loadVaults()
          })}
        >
          Leave vault
        </button>
      )}
    </section>
  )
}

function MemberRow({
  member,
  isSelf,
  canManage,
  busy,
  onRole,
  onRemove,
  onTransfer,
}: {
  member: Member
  isSelf: boolean
  canManage: boolean
  busy: boolean
  onRole: () => Promise<void>
  onRemove: () => Promise<void>
  onTransfer: () => Promise<void>
}) {
  const pending = isPendingInvite(member)
  return (
    <li className="flex items-center justify-between gap-2 px-2 py-1.5">
      <span className="min-w-0 truncate">
        <span className={pending ? 'text-neutral-400' : 'text-neutral-200'}>{memberLabel(member)}</span>
        {isSelf && <span className="ml-1 text-xs text-neutral-500">(you)</span>}
        {/* They have access already — they simply have not signed in yet. Saying so beats
          * a nameless row that reads like a bug. */}
        {pending && <span className="ml-1 text-xs text-amber-400/80">pending — not signed in yet</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs">
        <span className="text-neutral-500">{member.role}</span>
        {canManage && !isSelf && (
          <>
            <button disabled={busy} className="rounded px-1 hover:bg-neutral-800 disabled:opacity-50" onClick={onRole}>
              {member.role === 'owner' ? 'make member' : 'make owner'}
            </button>
            <button disabled={busy} className="rounded px-1 hover:bg-neutral-800 disabled:opacity-50" onClick={onTransfer}>
              transfer
            </button>
            <button
              disabled={busy}
              className="rounded px-1 text-red-400 hover:bg-neutral-800 disabled:opacity-50"
              onClick={onRemove}
            >
              remove
            </button>
          </>
        )}
      </span>
    </li>
  )
}
