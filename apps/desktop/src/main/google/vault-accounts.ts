/**
 * Which Google account each vault uses (D87).
 *
 * **Machine-local, and outside the vault**, keyed by remote (D60: a vault's
 * identity is its remote). A vault's clone can be deleted and re-made, and a
 * mapping that lived inside it would silently unlink the account with it. Every
 * other decision about a *connected account* already lives in `userData` — the
 * calendar choices, the image-sender allowances, the tokens — under the argument
 * `index.ts` makes about the image prefs: a vault is a shared git repo, and this
 * is a fact about an account rather than about the repo.
 *
 * Plain JSON, unencrypted, exactly like `calendar-prefs.ts` next door and unlike
 * `token-store.ts`: there is no credential here, only the id of an account whose
 * tokens are kept elsewhere. Holi's users are developers, and a config file they
 * can open and fix is worth more than hiding a list of account ids.
 *
 * Read per call rather than cached in memory, also matching `calendar-prefs.ts`:
 * that file already does a read per agenda call, so the cost is within the
 * tolerance this codebase has already set, and it removes cache invalidation
 * from a file the settings UI and the agent's door both resolve through.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** `owner/repo` → Google's stable account id (`sub`). */
export type VaultAccounts = Record<string, string>

export interface VaultAccountsStore {
  /** The account this vault uses, or null for one that has never connected. */
  subFor(remote: string): Promise<string | null>
  /** Snapshot, for the settings UI and for `unlinkAccount`. */
  all(): Promise<VaultAccounts>
  link(remote: string, sub: string): Promise<void>
  /** Forget this vault's choice. The account and its tokens are untouched — a
   *  vault unlinking must never cost another vault its connection. */
  unlinkVault(remote: string): Promise<void>
  /** Forget every vault pointing at `sub`, for when the account itself goes. */
  unlinkAccount(sub: string): Promise<void>
}

export function createVaultAccounts(path: string): VaultAccountsStore {
  const all = async (): Promise<VaultAccounts> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return {} // not written yet: no vault has connected
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: VaultAccounts = {}
      for (const [remote, sub] of Object.entries(parsed)) {
        // Anything else is a hand-edit gone wrong. Dropping the entry costs one
        // vault its link, which is a better answer than building a session — or
        // a cache filename — out of a number.
        if (typeof sub === 'string' && sub !== '') out[remote] = sub
      }
      return out
    } catch {
      // Corrupt file costs the user their links, never their mail.
      return {}
    }
  }

  const save = async (next: VaultAccounts): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    // Written aside and renamed: a crash mid-write must not leave a truncated
    // file, which `all` would discard along with every other link.
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }

  return {
    all,
    async subFor(remote) {
      return (await all())[remote] ?? null
    },
    async link(remote, sub) {
      await save({ ...(await all()), [remote]: sub })
    },
    async unlinkVault(remote) {
      const next = { ...(await all()) }
      delete next[remote]
      await save(next)
    },
    async unlinkAccount(sub) {
      const next = Object.fromEntries(
        Object.entries(await all()).filter(([, value]) => value !== sub),
      )
      await save(next)
    },
  }
}
