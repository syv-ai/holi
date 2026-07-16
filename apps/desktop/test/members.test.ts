import { createStore } from 'jotai'
import { describe, expect, it } from 'vitest'
import type { Vault } from '@holi/shared'
import { isPendingInvite, memberLabel, shareableVaultAtom, type Member } from '../src/renderer/src/state/members'
import { activeVaultIdAtom, vaultsAtom } from '../src/renderer/src/state/vaults'

const member = (over: Partial<Member> = {}): Member => ({
  userId: 'u1',
  role: 'member',
  email: 'teammate@syv.ai',
  name: 'Teammate',
  avatarUrl: null,
  ...over,
})

const vault = (over: Partial<Vault> = {}): Vault => ({
  id: 'v1',
  name: 'Team',
  kind: 'shared',
  ownerId: 'u1',
  createdAt: '2026-07-16',
  updatedAt: '2026-07-16',
  ...over,
})

describe('isPendingInvite', () => {
  // A name only arrives from Google on first sign-in, so a null name means they were
  // invited and haven't shown up — they have access already.
  it('reads a missing name as never-signed-in', () => {
    expect(isPendingInvite(member({ name: null }))).toBe(true)
    expect(isPendingInvite(member({ name: 'Teammate' }))).toBe(false)
  })
})

describe('memberLabel', () => {
  it('prefers the name', () => {
    expect(memberLabel(member())).toBe('Teammate')
  })

  it('falls back to the email — all a pending invitee ever gave us', () => {
    expect(memberLabel(member({ name: null }))).toBe('teammate@syv.ai')
  })
})

describe('shareableVaultAtom (mirrors the D49 server block)', () => {
  const store = (vaults: Vault[], activeId: string | null) => {
    const s = createStore()
    s.set(vaultsAtom, vaults)
    s.set(activeVaultIdAtom, activeId)
    return s
  }

  it('resolves a shared vault', () => {
    expect(store([vault()], 'v1').get(shareableVaultAtom)?.id).toBe('v1')
  })

  // The client mirror of the hard block: a personal vault has exactly one member and
  // cannot gain another, so the panel must not offer controls the server will refuse.
  it('resolves null for a personal vault', () => {
    expect(store([vault({ kind: 'personal' })], 'v1').get(shareableVaultAtom)).toBeNull()
  })

  it('resolves null when no vault is active or it is unknown', () => {
    expect(store([vault()], null).get(shareableVaultAtom)).toBeNull()
    expect(store([vault()], 'missing').get(shareableVaultAtom)).toBeNull()
  })
})
