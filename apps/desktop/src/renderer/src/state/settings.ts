/**
 * The active vault's resolved settings, read once per vault.
 *
 * `.holi/settings/app.yaml` under its per-key `.holi/settings/app.local.yaml`
 * override, resolved in main (`vault/settings.ts`) and handed over whole. The
 * renderer never parses either file, so every value crossed
 * `resolveVaultSettings`.
 *
 * **Cached, and keyed by remote.** The launch sequence asks twice in quick
 * succession (the landing and the sweep both need `dailyNotes`). Keying on the
 * remote is the whole invalidation rule.
 *
 * A settings file edited *while* the app runs is not picked up here until the
 * next vault open: these are decisions about how a vault starts.
 */
import { atom } from 'jotai'
import type { ResolvedVaultSettings } from '@holi/shared'
import { trpc } from '../lib/trpc'
import { activeRemoteAtom } from './vaults'

/** The cache. Holds the remote it was read for, so a stale vault's answer can
 *  never be served. */
export const vaultSettingsAtom = atom<{
  remote: string
  settings: ResolvedVaultSettings
} | null>(null)

/**
 * The active vault's settings, from the cache or from main.
 *
 * Returns `null` only when there is no active vault. `force` re-reads even on a
 * cache hit, for a caller that has just written the file and needs to see its
 * own write.
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
