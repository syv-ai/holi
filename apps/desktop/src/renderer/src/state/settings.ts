/**
 * The active vault's resolved settings, read once per vault.
 *
 * `.holi/settings.json` under its per-key `.holi/settings.local.json` override,
 * resolved in main (`vault/settings.ts`) and handed over whole. The renderer
 * never parses either file — a settings value that reached the workspace without
 * crossing `resolveVaultSettings` would be a value nothing validated.
 *
 * **Cached, and keyed by remote.** The launch sequence asks twice in quick
 * succession — the landing target needs `dailyNotes`, and so does the sweep
 * running right behind it — and two reads per launch would put back a file read
 * this slice exists to remove (it deletes a `github.collaborators` round-trip).
 * Keying on the remote is the whole invalidation rule: a vault switch cannot
 * serve the previous vault's answer, because the key no longer matches.
 *
 * A settings file edited *while* the app runs is not picked up until the next
 * vault open, which is the same contract the theme has and for the same reason:
 * these are decisions about how a vault starts, and re-reading them mid-session
 * would mean answering "what happens to the tab you are looking at".
 */
import { atom } from 'jotai'
import type { ResolvedVaultSettings } from '@holi/shared'
import { trpc } from '../lib/trpc'
import { activeRemoteAtom } from './vaults'

/** The cache. Holds the remote it was read for, so a stale vault's answer can
 *  never be served — see `loadVaultSettingsAtom`. */
export const vaultSettingsAtom = atom<{
  remote: string
  settings: ResolvedVaultSettings
} | null>(null)

/**
 * The active vault's settings, from the cache or from main.
 *
 * Returns `null` only when there is no active vault. `force` re-reads even on a
 * cache hit — for the one caller that has just written the file and needs to see
 * its own write (the onboarding step, slice 2).
 */
export const loadVaultSettingsAtom = atom(
  null,
  async (get, set, opts?: { force?: boolean }): Promise<ResolvedVaultSettings | null> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return null

    const cached = get(vaultSettingsAtom)
    if (opts?.force !== true && cached !== null && cached.remote === remote) {
      return cached.settings
    }

    const settings = await trpc.settings.read.query({ remote })
    set(vaultSettingsAtom, { remote, settings })
    return settings
  },
)
