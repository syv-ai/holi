import { atom } from 'jotai'
import type { PluginEventHandler, PluginStore } from '@/plugin-api'
import type { MailAttentionSnapshot } from '../shared/types'
import { googleCap } from './google-cap'

interface AttentionState {
  remote: string | null
  generation: number
  active: boolean
  snapshot: MailAttentionSnapshot | null
}

const EMPTY: AttentionState = {
  remote: null,
  generation: 0,
  active: false,
  snapshot: null,
}

const mailAttentionStateAtom = atom<AttentionState>(EMPTY)

/** A sidebar number is current only after a successful exact Gmail count. */
export const mailUnreadAtom = atom((get): number | null => {
  const snapshot = get(mailAttentionStateAtom).snapshot
  return snapshot?.status === 'fresh' ? snapshot.unreadThreads : null
})

function isSnapshot(value: unknown): value is MailAttentionSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Partial<MailAttentionSnapshot>
  return (
    (snapshot.accountSub === null || typeof snapshot.accountSub === 'string') &&
    (snapshot.unreadThreads === null ||
      (typeof snapshot.unreadThreads === 'number' &&
        Number.isInteger(snapshot.unreadThreads) &&
        snapshot.unreadThreads >= 0)) &&
    (snapshot.status === 'disconnected' ||
      snapshot.status === 'unknown' ||
      snapshot.status === 'fresh' ||
      snapshot.status === 'stale') &&
    typeof snapshot.revision === 'number' &&
    Number.isInteger(snapshot.revision) &&
    snapshot.revision >= 0 &&
    (snapshot.updatedAt === null || typeof snapshot.updatedAt === 'string')
  )
}

function reconcile(
  store: PluginStore,
  remote: string,
  generation: number,
  snapshot: MailAttentionSnapshot,
): void {
  const current = store.get(mailAttentionStateAtom)
  if (!current.active || current.remote !== remote || current.generation !== generation) return
  if (current.snapshot !== null && snapshot.revision <= current.snapshot.revision) return
  store.set(mailAttentionStateAtom, { ...current, snapshot })
}

/** Events are installed at app boot; the vault hook starts bootstrap afterwards. */
export const mailAttentionChanged: PluginEventHandler = ({ remote, payload }, store) => {
  if (!isSnapshot(payload)) return
  const current = store.get(mailAttentionStateAtom)
  reconcile(store, remote, current.generation, payload)
}

/**
 * Own one open-vault attention lifecycle. A late A bootstrap cannot land after
 * A→B→A because each activation has a distinct generation, even for the same remote.
 */
export function startMailAttention(remote: string, store: PluginStore): () => void {
  const generation = store.get(mailAttentionStateAtom).generation + 1
  store.set(mailAttentionStateAtom, {
    remote,
    generation,
    active: true,
    snapshot: null,
  })

  void googleCap
    .mailAttention(remote)
    .then((snapshot) => reconcile(store, remote, generation, snapshot))
    .catch(() => undefined)

  return () => {
    const current = store.get(mailAttentionStateAtom)
    if (current.remote !== remote || current.generation !== generation) return
    store.set(mailAttentionStateAtom, {
      remote: null,
      generation: generation + 1,
      active: false,
      snapshot: null,
    })
  }
}
