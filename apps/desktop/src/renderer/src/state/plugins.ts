/**
 * The plugins this build has, and which of them the open vault runs
 * (docs/architecture.md, Plugins).
 *
 * `main.tsx` installs the list once at boot; nothing else in core imports a
 * plugin. Which ones run follows the vault's `plugins` setting, through the
 * same resolver main uses (`enabledPlugins`), so the two cannot disagree.
 *
 * Core's own surfaces, rail items and claims are installed the same way,
 * beside the plugins' (`components/core-surfaces.tsx`): they render features,
 * which state does not import.
 */
import { atom } from 'jotai'
import { enabledPlugins, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { folderClaims, surfaceLabel, type FolderDocumentClaim } from '@/lib/folder-documents'
import type {
  PathClaim,
  RailItem,
  RendererPlugin,
  SettingsSection,
  Surface,
} from '@/plugin-api/types'
import type { FolderSurface } from './panes'
import { vaultSettingsAtom } from './settings'
import { activeRemoteAtom } from './vaults'

export const installedPluginsAtom = atom<readonly RendererPlugin[]>([])

/** What core contributes the way a plugin does: its own surfaces, rail items
 *  and claims. Always on. */
export type CoreContribution = Pick<Required<RendererPlugin>, 'surfaces' | 'rail' | 'claims'>

export const coreContributionAtom = atom<CoreContribution>({ surfaces: [], rail: [], claims: [] })

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

/** Core's path claims, then every enabled plugin's, in list order. */
export const claimsAtom = atom((get): readonly PathClaim[] => {
  const enabled = get(enabledPluginsAtom)
  return [
    ...get(coreContributionAtom).claims,
    ...get(installedPluginsAtom).flatMap((p) => (enabled.has(p.info.id) ? (p.claims ?? []) : [])),
  ]
})

/** The claims that make directories documents (`PathClaim.folder`). */
export const folderClaimsAtom = atom((get): readonly FolderDocumentClaim[] =>
  folderClaims(get(claimsAtom)),
)

/** The same, as the panes need them to follow a moved or deleted one. */
export const folderSurfacesAtom = atom((get): readonly FolderSurface[] =>
  get(folderClaimsAtom).map(({ claim, folder }) => ({
    surface: folder.surface,
    entry: folder.entry,
    match: (path: string) => claim.match(path),
  })),
)

/** Every enabled plugin's settings sections, in list order. */
export const pluginSettingsSectionsAtom = atom((get): readonly SettingsSection[] => {
  const enabled = get(enabledPluginsAtom)
  return get(installedPluginsAtom).flatMap((p) =>
    enabled.has(p.info.id) ? (p.settingsSections ?? []) : [],
  )
})

/** Core's contribution, then every enabled plugin's, in list order. */
const contributionsAtom = atom((get): readonly Pick<RendererPlugin, 'surfaces' | 'rail'>[] => {
  const enabled = get(enabledPluginsAtom)
  return [
    get(coreContributionAtom),
    ...get(installedPluginsAtom).filter((p) => enabled.has(p.info.id)),
  ]
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

/** Every registered surface's instances, with their labels, in registry
 *  order: what the palette lists for a surface of instances (each app). */
export const instancesAtom = atom(
  (get): readonly { surface: string; id: string; label: string }[] =>
    [...get(surfacesAtom).values()].flatMap((s) =>
      s.instances === undefined
        ? []
        : get(s.instances).map((id) => ({ surface: s.kind, id, label: surfaceLabel(s, id) })),
    ),
)

/**
 * The nav menu's surface items, in order, with their surfaces: only those
 * whose surface exists and whose `visible` atom says so. A surface with
 * instances is a group of them, shown while there are any. One derived atom
 * reads every `visible` and every `instances`, so the menu calls no hook per
 * item.
 */
export const railAtom = atom(
  (get): readonly (RailItem & { of: Surface; instances?: readonly string[] })[] => {
    const surfaces = get(surfacesAtom)
    return get(contributionsAtom)
      .flatMap((c) => c.rail ?? [])
      .flatMap((item) => {
        const of = surfaces.get(item.surface)
        if (of === undefined || (item.visible !== undefined && !get(item.visible))) return []
        if (of.instances === undefined) return [{ ...item, of }]
        const instances = get(of.instances)
        return instances.length === 0 ? [] : [{ ...item, of, instances }]
      })
      .sort((a, b) => a.order - b.order)
  },
)
