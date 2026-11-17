import { atom, getDefaultStore } from 'jotai'
import {
  activeRemoteRevisionValueAtom,
  capClient,
  type AskResult,
  type UiCapability,
} from '@/plugin-api'

type Store = ReturnType<typeof getDefaultStore>

type Uncertain = {
  kind: 'uncertain'
  id: symbol
  sessionId: string | null
  error: string
  confirmation?: symbol
  recoveryError?: string
}

/** Catch-up startup belongs to the vault, not any one mounted Mail surface. */
type MailCatchUpState =
  | { kind: 'pending'; id: symbol }
  // A clean error survives Mail remount, but not a stale vault selection.
  | { kind: 'failed'; id: symbol; revision: number; error: string }
  | Uncertain

const recoveryCap = capClient<{
  'agent.stop': UiCapability<{ id: string }, AskResult>
}>('agent')

export const mailCatchUpByVaultAtom = atom<ReadonlyMap<string, MailCatchUpState>>(new Map())

export function beginMailCatchUp(store: Store, remote: string): symbol | null {
  const current = store.get(mailCatchUpByVaultAtom).get(remote)
  // A clean failure is explicitly consumed by the next attempt, never by a remount.
  if (current !== undefined && current.kind !== 'failed') return null
  const id = Symbol(remote)
  const next = new Map(store.get(mailCatchUpByVaultAtom))
  next.set(remote, { kind: 'pending', id })
  store.set(mailCatchUpByVaultAtom, next)
  return id
}

export function finishMailCatchUp(
  store: Store,
  remote: string,
  id: symbol,
  result:
    | { kind: 'done' }
    | { kind: 'failed'; revision: number; error: string }
    | { kind: 'uncertain'; sessionId: string | null; error: string },
): void {
  const current = store.get(mailCatchUpByVaultAtom).get(remote)
  if (current?.id !== id || current.kind !== 'pending') return
  const next = new Map(store.get(mailCatchUpByVaultAtom))
  if (result.kind === 'done') next.delete(remote)
  else next.set(remote, { ...result, id })
  store.set(mailCatchUpByVaultAtom, next)
}

export function reportMailCatchUpRecoveryError(
  store: Store,
  remote: string,
  id: symbol,
  error: string,
): void {
  const current = store.get(mailCatchUpByVaultAtom).get(remote)
  if (current?.id !== id || current.kind !== 'uncertain') return
  const next = new Map(store.get(mailCatchUpByVaultAtom))
  next.set(remote, { ...current, recoveryError: error })
  store.set(mailCatchUpByVaultAtom, next)
}

/** Only a successful stop of this admission's known session is cleanup proof.
 * A listing miss, opening a terminal, or an unknown id is never proof. */
export async function confirmMailCatchUpCleanup(
  store: Store,
  remote: string,
  id: symbol,
  isCurrent: () => boolean,
): Promise<void> {
  const current = store.get(mailCatchUpByVaultAtom).get(remote)
  if (
    current?.id !== id ||
    current.kind !== 'uncertain' ||
    current.sessionId === null ||
    current.confirmation !== undefined ||
    !isCurrent()
  )
    return
  const revision = store.get(activeRemoteRevisionValueAtom)
  const confirmation = Symbol('cleanup')
  const next = new Map(store.get(mailCatchUpByVaultAtom))
  next.set(remote, { ...current, confirmation, recoveryError: undefined })
  store.set(mailCatchUpByVaultAtom, next)
  let result: AskResult
  try {
    result = await recoveryCap.stop(remote, { id: current.sessionId })
  } catch (error) {
    result = {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not confirm cleanup.',
    }
  }
  const latest = store.get(mailCatchUpByVaultAtom).get(remote)
  if (
    latest?.id !== id ||
    latest.kind !== 'uncertain' ||
    latest.sessionId !== current.sessionId ||
    latest.confirmation !== confirmation
  )
    return
  const settled = new Map(store.get(mailCatchUpByVaultAtom))
  if (isCurrent() && store.get(activeRemoteRevisionValueAtom) === revision) {
    if (result.ok) settled.delete(remote)
    else settled.set(remote, { ...latest, confirmation: undefined, recoveryError: result.message })
  } else {
    // The confirmation was not consumed in its context. Keep the admission;
    // a fresh explicit stop can confirm it when the person returns.
    settled.set(remote, { ...latest, confirmation: undefined })
  }
  store.set(mailCatchUpByVaultAtom, settled)
}
