import { atom, getDefaultStore } from 'jotai'

type Store = ReturnType<typeof getDefaultStore>

/** Catch-up startup belongs to the vault, not any one mounted Mail surface. */
export type MailCatchUpState =
  | { kind: 'pending'; id: symbol; revision: number }
  | { kind: 'uncertain'; id: symbol; revision: number; sessionId: string | null; error: string }

export const mailCatchUpByVaultAtom = atom<ReadonlyMap<string, MailCatchUpState>>(new Map())

export function beginMailCatchUp(store: Store, remote: string, revision: number): symbol | null {
  const states = mailCatchUpByVaultAtom
  if (store.get(states).has(remote)) return null
  const id = Symbol(remote)
  const next = new Map(store.get(states))
  next.set(remote, { kind: 'pending', id, revision })
  store.set(states, next)
  return id
}

export function finishMailCatchUp(
  store: Store,
  remote: string,
  id: symbol,
  result:
    | { kind: 'done' }
    | { kind: 'failed' }
    | { kind: 'uncertain'; sessionId: string | null; error: string },
): void {
  const states = mailCatchUpByVaultAtom
  const current = store.get(states).get(remote)
  if (current?.id !== id) return
  const next = new Map(store.get(states))
  if (result.kind === 'uncertain')
    next.set(remote, {
      ...current,
      kind: 'uncertain',
      sessionId: result.sessionId,
      error: result.error,
    })
  else next.delete(remote)
  store.set(states, next)
}
