/**
 * Which Google account each vault uses.
 *
 * **Machine-local, and outside the vault**, keyed by remote. A vault is a
 * shared git repo and its clone can be deleted and re-made; this is a fact about
 * an account, so it lives in `userData` beside the tokens and other account
 * prefs.
 *
 * Plain JSON, unencrypted, unlike `token-store.ts`: there is no credential
 * here, only the id of an account whose tokens are kept elsewhere.
 *
 * Read per call rather than cached, which removes cache invalidation from a
 * file the settings UI and the agent's door both resolve through.
 */
import { jsonFileStore } from '../../../main/plugin-api'

/** `owner/repo` → Google's stable account id (`sub`). */
type VaultAccounts = Record<string, string>

type VaultAccountBinding = { sub: string | null; revision: number }

export interface VaultAccountsStore {
  /** The account this vault uses, or null for one that has never connected. */
  subFor(remote: string): Promise<string | null>
  /** Coherent snapshot of the mapping and its main-process publication revision. */
  bindingFor(remote: string): Promise<VaultAccountBinding>
  /** Revalidate a snapshot from bindingFor for the same remote. Does not yield. */
  isCurrentBinding(remote: string, binding: VaultAccountBinding): boolean
  /** Snapshot, for the settings UI and for `unlinkAccount`. */
  all(): Promise<VaultAccounts>
  link(remote: string, sub: string): Promise<() => Promise<void>>
  /** Forget this vault's choice. The account and its tokens are untouched: a
   *  vault unlinking must never cost another vault its connection. */
  unlinkVault(remote: string): Promise<void>
  /** Forget every vault pointing at `sub`, for when the account itself goes. */
  unlinkAccount(sub: string): Promise<void>
  /** Google refused `sub`'s grant: unlink its vaults and remember that they
   *  need a reconnect. Not left linked, or connecting the account in another
   *  vault would silently give these back its mailbox. */
  expireAccount(sub: string): Promise<void>
  /** Whether this vault lost its account to a refused grant and has neither
   *  connected again nor let go since. */
  needsReconnect(remote: string): Promise<boolean>
}

/** Not written yet (no vault has connected) or corrupt (the user loses their
 *  links, never their mail): no links. */
function parseAccounts(parsed: unknown): VaultAccounts {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: VaultAccounts = {}
  for (const [remote, sub] of Object.entries(parsed)) {
    // Anything else is a hand-edit gone wrong. Dropping the entry costs one
    // vault its link, which beats building a session or a cache filename
    // out of a number.
    if (typeof sub === 'string' && sub !== '') out[remote] = sub
  }
  return out
}

export function createVaultAccounts(path: string): VaultAccountsStore {
  const store = jsonFileStore(path, parseAccounts)
  /** Same shape, beside the links: a vault → the account it lost. */
  const expired = jsonFileStore(path.replace(/\.json$/, '') + '.expired.json', parseAccounts)
  const without = (current: VaultAccounts, drop: (remote: string, sub: string) => boolean) =>
    Object.fromEntries(Object.entries(current).filter(([remote, sub]) => !drop(remote, sub)))
  /** One change at a time across both files: a link or a removal landing inside
   *  an expiry would leave a mark on a vault that has moved on. */
  let queue: Promise<unknown> = Promise.resolve()
  const serial = (change: () => Promise<void>): Promise<void> => {
    const run = queue.then(change, change)
    queue = run.catch(() => undefined)
    return run
  }
  const owners = new Map<string, symbol>()
  const restore = (current: VaultAccounts, remote: string, previous: string | undefined) => {
    const next = { ...current }
    if (previous === undefined) delete next[remote]
    else next[remote] = previous
    return next
  }
  const revisions = new Map<string, number>()
  const revisionOf = (remote: string) => revisions.get(remote) ?? 0
  const publish = (change: (current: VaultAccounts) => VaultAccounts, relink?: string) => {
    let changed: string[] = []
    return store.update(
      (current) => {
        const next = change(current)
        changed = [...new Set([...Object.keys(current), ...Object.keys(next)])].filter(
          (remote) => current[remote] !== next[remote] || remote === relink,
        )
        return next
      },
      undefined,
      () => {
        // The store renames synchronously after this guard. Invalidate at
        // publication, not when the surrounding async operation finishes.
        for (const remote of changed) revisions.set(remote, revisionOf(remote) + 1)
        return true
      },
    )
  }
  /** Only when there is one to clear: most machines never lose a grant. */
  const clearExpired = async (drop: (remote: string, sub: string) => boolean) => {
    const current = await expired.read()
    if (Object.entries(current).some(([remote, sub]) => drop(remote, sub))) {
      await expired.update((latest) => without(latest, drop))
    }
  }
  return {
    all: store.read,
    async subFor(remote) {
      return (await store.read())[remote] ?? null
    },
    async bindingFor(remote) {
      for (;;) {
        const revision = revisionOf(remote)
        const sub = (await store.read())[remote] ?? null
        if (revision === revisionOf(remote)) return { sub, revision }
      }
    },
    isCurrentBinding(remote, binding) {
      return revisionOf(remote) === binding.revision
    },
    async link(remote, sub) {
      const owner = Symbol('google-vault-link')
      let previous: string | undefined
      let previousExpired: string | undefined
      await serial(async () => {
        previous = (await store.read())[remote]
        previousExpired = (await expired.read())[remote]
        await publish((current) => ({ ...current, [remote]: sub }), remote)
        try {
          await clearExpired((key) => key === remote)
        } catch (error) {
          // Fail closed: do not advertise a link whose expired marker could
          // not be cleared, and preserve the original failure if rollback fails.
          try {
            await publish((current) => restore(current, remote, previous), remote)
          } catch {
            // The mapping store itself is failing; callers must treat link as
            // failed and never publish a connected session.
          }
          throw error
        }
        owners.set(remote, owner)
      })
      return () =>
        serial(async () => {
          if (owners.get(remote) !== owner) return
          // Roll back only while this transaction still owns the published
          // value; never undo a later successful link or unlink.
          if ((await store.read())[remote] === sub) {
            await publish((current) => restore(current, remote, previous), remote)
            await expired.update((current) => restore(current, remote, previousExpired))
          }
          owners.delete(remote)
        })
    },
    unlinkVault(remote) {
      return serial(async () => {
        owners.delete(remote)
        await publish((current) => without(current, (key) => key === remote))
        await clearExpired((key) => key === remote)
      })
    },
    unlinkAccount(sub) {
      return serial(async () => {
        for (const [remote, value] of Object.entries(await store.read()))
          if (value === sub) owners.delete(remote)
        await publish((current) => without(current, (_, value) => value === sub))
        await clearExpired((_, value) => value === sub)
      })
    },
    expireAccount(sub) {
      return serial(async () => {
        const links = await store.read()
        const lost = Object.keys(links).filter((remote) => links[remote] === sub)
        for (const remote of lost) owners.delete(remote)
        await expired.update((current) => ({
          ...current,
          ...Object.fromEntries(lost.map((remote) => [remote, sub])),
        }))
        await publish((current) => without(current, (_, value) => value === sub))
      })
    },
    async needsReconnect(remote) {
      return (await expired.read())[remote] !== undefined
    },
  }
}
