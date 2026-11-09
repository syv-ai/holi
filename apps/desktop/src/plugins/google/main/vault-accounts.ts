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

export interface VaultAccountsStore {
  /** The account this vault uses, or null for one that has never connected. */
  subFor(remote: string): Promise<string | null>
  /** Snapshot, for the settings UI and for `unlinkAccount`. */
  all(): Promise<VaultAccounts>
  link(remote: string, sub: string): Promise<void>
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
    async link(remote, sub) {
      await store.update((current) => ({ ...current, [remote]: sub }))
      await clearExpired((key) => key === remote)
    },
    async unlinkVault(remote) {
      await store.update((current) => without(current, (key) => key === remote))
      await clearExpired((key) => key === remote)
    },
    async unlinkAccount(sub) {
      await store.update((current) => without(current, (_, value) => value === sub))
      await clearExpired((_, value) => value === sub)
    },
    async expireAccount(sub) {
      const links = await store.read()
      const lost = Object.keys(links).filter((remote) => links[remote] === sub)
      await expired.update((current) => ({
        ...current,
        ...Object.fromEntries(lost.map((remote) => [remote, sub])),
      }))
      await store.update((current) => without(current, (_, value) => value === sub))
    },
    async needsReconnect(remote) {
      return (await expired.read())[remote] !== undefined
    },
  }
}
