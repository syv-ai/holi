/**
 * The plugins this build has, and which of them the open vault runs
 * (docs/architecture.md, Plugins).
 *
 * `main.tsx` installs the list once at boot; nothing else in core imports a
 * plugin. Which ones run follows the vault's `plugins` setting, through the
 * same resolver main uses (`enabledPlugins`), so the two cannot disagree.
 */
import { atom } from 'jotai'
import { enabledPlugins, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import type { PathClaim, RendererPlugin } from '@/plugin-api/types'
import { vaultSettingsAtom } from './settings'
import { activeRemoteAtom } from './vaults'

export const installedPluginsAtom = atom<readonly RendererPlugin[]>([])

/** The ids the open vault runs. Each plugin's default until its settings
 *  are read. */
export const enabledPluginsAtom = atom((get): ReadonlySet<string> => {
  const cached = get(vaultSettingsAtom)
  const settings =
    cached !== null && cached.remote === get(activeRemoteAtom)
      ? cached.settings.plugins
      : VAULT_SETTING_DEFAULTS.plugins
  return enabledPlugins(
    settings,
    get(installedPluginsAtom).map((p) => p.info),
  )
})

/** Every enabled plugin's path claims, in list order. */
export const claimsAtom = atom((get): readonly PathClaim[] => {
  const enabled = get(enabledPluginsAtom)
  return get(installedPluginsAtom).flatMap((p) => (enabled.has(p.info.id) ? (p.claims ?? []) : []))
})
