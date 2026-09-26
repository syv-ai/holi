/**
 * Which Google account each vault uses (D87).
 *
 * **Machine-local, and outside the vault**, keyed by remote (D60). A vault is a
 * shared git repo and its clone can be deleted and re-made; this is a fact about
 * an account, so it lives in `userData` beside the tokens and other account
 * prefs.
 *
 * Plain JSON, unencrypted, like `calendar-prefs.ts`: there is no credential
 * here, only the id of an account whose tokens are kept elsewhere.
 *
 * Read per call rather than cached, which removes cache invalidation from a
 * file the settings UI and the agent's door both resolve through.
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
  /** Forget this vault's choice. The account and its tokens are untouched: a
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
        // vault its link, which beats building a session or a cache filename
        // out of a number.
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
