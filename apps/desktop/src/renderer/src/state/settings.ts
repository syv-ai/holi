/**
 * The active vault's resolved settings, read once per vault.
 *
 * `.holi/settings/app.yaml` under its per-key `.holi/settings/app.local.yaml`
 * override, resolved in main (`vault/settings.ts`) and handed over whole. The
 * renderer never parses either file, so every value crossed
 * `resolveVaultSettings`.
 *
 * **Cached, and keyed by remote.** The launch sequence asks twice in quick
 * succession (the vault's opening and the sweep both need `dailyNotes`). Keying on the
 * remote is the whole invalidation rule.
 *
 * A settings file edited on disk while the app runs (by the agent, by hand, or
 * by a pull) is re-read through `useSettingsFollowDisk`, so the Home tab and
 * the live settings follow it.
 */
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import {
  PLUGINS_FILE,
  PLUGINS_LOCAL_FILE,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  VAULT_SETTING_DEFAULTS,
  pluginSettingValue,
  type PluginInfo,
  type ResolvedVaultSettings,
} from '@holi/shared'
import { trpc } from '../lib/trpc'
import { activeRemoteAtom, snapshotAtom } from './vaults'

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

const SETTINGS_FILES = new Set([
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  PLUGINS_FILE,
  PLUGINS_LOCAL_FILE,
])

/** The four settings files as the snapshot last saw them. */
const settingsFilesAtom = atom((get): string =>
  get(snapshotAtom)
    .files.filter((f) => SETTINGS_FILES.has(f.path))
    .map((f) => `${f.path}@${f.updatedAt}`)
    .join('|'),
)

/** Re-read the settings when any of the files changes on disk. Mounted once, in Shell. */
export function useSettingsFollowDisk(): void {
  const files = useAtomValue(settingsFilesAtom)
  const load = useSetAtom(loadVaultSettingsAtom)
  const first = useRef(true)
  useEffect(() => {
    // The vault's open reads them; this answers only a later change.
    if (first.current) {
      first.current = false
      return
    }
    load({ force: true }).catch((e: unknown) => console.warn('[settings] re-read failed:', e))
  }, [files, load])
}

/** A plugin's own setting in the open vault (`PluginInfo.settings`): its
 *  default until the vault's settings are read. */
export function usePluginSetting(info: PluginInfo, key: string): unknown {
  const cached = useAtomValue(vaultSettingsAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const values = cached !== null && cached.remote === remote ? cached.settings.pluginValues : {}
  return pluginSettingValue(values, info, key)
}

/** The agent a new session runs on this machine (`agentProvider`): its
 *  default until the vault's settings are read. */
export const agentProviderSettingAtom = atom((get) => {
  const cached = get(vaultSettingsAtom)
  return cached !== null && cached.remote === get(activeRemoteAtom)
    ? cached.settings.agentProvider
    : VAULT_SETTING_DEFAULTS.agentProvider
})
