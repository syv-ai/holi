/**
 * Whether Mail or Calendar in front folds the files sidebar to its rail: the
 * vault's machine-local `foldSidebarForApps` (`.holi/settings/app.local.yaml`),
 * read off the settings cache the way `grid-arcade.ts` reads `gridArcade`.
 */
import { atom } from 'jotai'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { vaultSettingsAtom } from './settings'
import { activeRemoteAtom } from './vaults'

export const foldSidebarForAppsAtom = atom((get): boolean => {
  const cached = get(vaultSettingsAtom)
  const remote = get(activeRemoteAtom)
  return cached !== null && cached.remote === remote
    ? cached.settings.foldSidebarForApps
    : VAULT_SETTING_DEFAULTS.foldSidebarForApps
})
