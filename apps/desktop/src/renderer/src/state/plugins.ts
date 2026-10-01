/**
 * The plugins this build has, and which of them the open vault runs
 * (docs/architecture.md, Plugins).
 *
 * `main.tsx` installs the list once at boot; nothing else in core imports a
 * plugin. Which ones run follows the vault's `plugins` setting, through the
 * same resolver main uses (`enabledPlugins`), so the two cannot disagree.
 *
 * Core's own surfaces and rail items are installed the same way, beside the
 * plugins' (`components/core-surfaces.tsx`): they render features, which state
 * does not import.
 */
import { atom } from 'jotai'
import { enabledPlugins, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import type { PathClaim, RailItem, RendererPlugin, Surface } from '@/plugin-api/types'
import { vaultSettingsAtom } from './settings'
import { activeRemoteAtom } from './vaults'

export const installedPluginsAtom = atom<readonly RendererPlugin[]>([])

/** Core's own surfaces and rail items. */
export const coreSurfacesAtom = atom<Pick<Required<RendererPlugin>, 'surfaces' | 'rail'>>({
  surfaces: [],
  rail: [],
})

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

/** Core's contribution, then every enabled plugin's, in list order. */
const contributionsAtom = atom((get): readonly Pick<RendererPlugin, 'surfaces' | 'rail'>[] => {
  const enabled = get(enabledPluginsAtom)
  return [get(coreSurfacesAtom), ...get(installedPluginsAtom).filter((p) => enabled.has(p.info.id))]
})

/** Every surface there is right now, by kind. The first to name a kind wins,
 *  so a plugin cannot take over one of core's. */
export const surfacesAtom = atom((get): ReadonlyMap<string, Surface> => {
  const byKind = new Map<string, Surface>()
  for (const c of get(contributionsAtom)) {
    for (const s of c.surfaces ?? []) if (!byKind.has(s.kind)) byKind.set(s.kind, s)
  }
  return byKind
})

/**
 * The nav menu's surface items, in order, with their surfaces: only those
 * whose surface exists and whose `visible` atom says so. One derived atom
 * reads every `visible`, so the menu calls no hook per item.
 */
export const railAtom = atom((get): readonly (RailItem & { of: Surface })[] => {
  const surfaces = get(surfacesAtom)
  return get(contributionsAtom)
    .flatMap((c) => c.rail ?? [])
    .flatMap((item) => {
      const of = surfaces.get(item.surface)
      if (of === undefined || (item.visible !== undefined && !get(item.visible))) return []
      return [{ ...item, of }]
    })
    .sort((a, b) => a.order - b.order)
})
