/**
 * The empty view's arcade (`components/monocode/arcade`): whether it plays,
 * the vault's machine-local `gridArcade` (`.holi/settings/app.local.yaml`),
 * read off the settings cache the way `window-glass.ts` reads `windowGlass`;
 * and who plays in it, the characters running plugins contribute
 * (`RendererPlugin.arcadeCast`: the holis plugin's are the vault's Holis).
 */
import { atom } from 'jotai'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import type { ArcadeCastMember } from '@/plugin-api/types'
import { runningPluginsAtom } from './plugins'
import { vaultSettingsAtom } from './settings'
import { activeRemoteAtom } from './vaults'

/** Whether the arcade plays behind the empty view, on this machine. */
export const gridArcadeAtom = atom((get): boolean => {
  const cached = get(vaultSettingsAtom)
  const remote = get(activeRemoteAtom)
  return cached !== null && cached.remote === remote
    ? cached.settings.gridArcade
    : VAULT_SETTING_DEFAULTS.gridArcade
})

/** Every running plugin's characters, in plugin order. Empty when none
 *  contributes any: the arcade then brings its default cast. */
export const arcadeCastAtom = atom((get): readonly ArcadeCastMember[] =>
  get(runningPluginsAtom).flatMap((plugin) =>
    plugin.arcadeCast === undefined ? [] : get(plugin.arcadeCast),
  ),
)
