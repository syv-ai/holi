/**
 * The plugins this build has, and which of them the open vault runs
 * (docs/architecture.md, Plugins).
 *
 * `main.tsx` installs the list once at boot; nothing else in core imports a
 * plugin. Which ones run follows the vault's `plugins` setting, through the
 * same resolver main uses (`resolvePlugins`), so the two cannot disagree.
 *
 * Core's own surfaces, rail items and claims are installed the same way,
 * beside the plugins' (`components/core-surfaces.tsx`): they render features,
 * which state does not import.
 */
import { atom, type Atom, type createStore } from 'jotai'
import {
  resolvePlugins,
  type PluginResolution,
  knownTransforms,
  vaultSettingDescriptors,
  VAULT_SETTING_DEFAULTS,
} from '@holi/shared'
import { folderClaims, surfaceLabel, type FolderDocumentClaim } from '@/lib/folder-documents'
import type {
  AgentServiceSource,
  PaletteItem,
  PathClaim,
  RailItem,
  RendererPlugin,
  SettingsSection,
  Surface,
  SurfaceTabLook,
} from '@/plugin-api/types'
import type { Command } from './commands'
import type { FolderSurface } from './panes'
import { vaultSettingsAtom } from './settings'
import { activeRemoteAtom } from './vaults'

export const installedPluginsAtom = atom<readonly RendererPlugin[]>([])

/** The settings rows, with the commit transforms of core and of every
 *  installed plugin in the `hooks` row: what the settings tab and the
 *  onboarding act render. */
export const settingDescriptorsAtom = atom((get) =>
  vaultSettingDescriptors(knownTransforms(get(installedPluginsAtom).map((p) => p.info))),
)

/** What core contributes the way a plugin does: its own surfaces, rail items
 *  and claims. Always on. */
export type CoreContribution = Pick<Required<RendererPlugin>, 'surfaces' | 'rail'> & {
  claims: readonly PathClaim[]
}

export const coreContributionAtom = atom<CoreContribution>({ surfaces: [], rail: [], claims: [] })

/** Which plugins the open vault runs and why each other one does not. Each
 *  plugin's default until its settings are read. */
export const pluginResolutionAtom = atom((get): PluginResolution => {
  const cached = get(vaultSettingsAtom)
  const settings =
    cached !== null && cached.remote === get(activeRemoteAtom)
      ? cached.settings.plugins
      : VAULT_SETTING_DEFAULTS.plugins
  return resolvePlugins(
    settings,
    get(installedPluginsAtom).map((p) => p.info),
  )
})

/** The ids the open vault runs. */
export const enabledPluginsAtom = atom((get) => get(pluginResolutionAtom).running)

/** Core's path claims, then every enabled plugin's, in list order. */
export const claimsAtom = atom((get): readonly PathClaim[] => {
  const enabled = get(enabledPluginsAtom)
  return [
    ...get(coreContributionAtom).claims,
    ...get(installedPluginsAtom).flatMap((p) => {
      if (!enabled.has(p.info.id) || p.claims === undefined) return []
      return Array.isArray(p.claims) ? p.claims : get(p.claims as Atom<readonly PathClaim[]>)
    }),
  ]
})

/** The claims whose files have a canonical form, for the editor's reload. */
export const normalizersAtom = atom((get): readonly PathClaim[] =>
  get(claimsAtom).filter((c) => c.normalize !== undefined),
)

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

/** Every enabled plugin, in list order. */
export const runningPluginsAtom = atom((get): readonly RendererPlugin[] => {
  const enabled = get(enabledPluginsAtom)
  return get(installedPluginsAtom).filter((p) => enabled.has(p.info.id))
})

/** Every running plugin's commands, in list order. */
export const pluginCommandsAtom = atom((get): readonly Command[] =>
  get(runningPluginsAtom).flatMap((p) => p.commands ?? []),
)

/** What running plugins list in the palette, each with its plugin's id. */
export const paletteItemsAtom = atom((get): readonly (PaletteItem & { plugin: string })[] =>
  get(runningPluginsAtom).flatMap((p) =>
    p.palette === undefined
      ? []
      : get(p.palette.items).map((item) => ({ ...item, plugin: p.info.id })),
  ),
)

/** Open a palette item through the plugin that listed it. */
export const openPaletteItemAtom = atom(
  null,
  (get, set, { plugin, key }: { plugin: string; key: string }): void => {
    const open = get(runningPluginsAtom).find((p) => p.info.id === plugin)?.palette?.open
    if (open !== undefined) set(open, key)
  },
)

/** Core's contribution, then every running plugin's, in list order. */
const contributionsAtom = atom((get): readonly Pick<RendererPlugin, 'surfaces' | 'rail'>[] => [
  get(coreContributionAtom),
  ...get(runningPluginsAtom),
])

/** Why leaving the open vault costs something now: every running plugin's
 *  `leaveGuard` sentence. Empty when leaving costs nothing. */
export const leaveReasonsAtom = atom((get): readonly string[] =>
  get(runningPluginsAtom).flatMap((p) => {
    const reason = p.leaveGuard === undefined ? null : get(p.leaveGuard)
    return reason === null ? [] : [reason]
  }),
)

/** The first running plugin's agent, or null with none. */
export const agentSourceAtom = atom(
  (get): AgentServiceSource | null =>
    get(runningPluginsAtom).find((p) => p.agent !== undefined)?.agent ?? null,
)

/**
 * Run each running plugin's `vault` hook while its vault is open: started
 * when a vault opens or the plugin starts running, undone when either stops.
 * Set up once, beside the event subscriptions, for the app's lifetime.
 */
export function hostPluginVaults(store: ReturnType<typeof createStore>): () => void {
  const live = new Map<string, { remote: string; plugin: RendererPlugin; undo: () => void }>()
  const sync = (): void => {
    const remote = store.get(activeRemoteAtom)
    const want = new Map(
      remote === null
        ? []
        : store
            .get(runningPluginsAtom)
            .filter((p) => p.vault !== undefined)
            .map((p) => [p.info.id, p] as const),
    )
    for (const [id, run] of [...live]) {
      if (want.get(id) === run.plugin && run.remote === remote) continue
      live.delete(id)
      run.undo()
    }
    for (const [id, plugin] of want) {
      if (live.has(id) || remote === null) continue
      live.set(id, { remote, plugin, undo: plugin.vault!(remote, store) })
    }
  }
  sync()
  const offRemote = store.sub(activeRemoteAtom, sync)
  const offRunning = store.sub(runningPluginsAtom, sync)
  return () => {
    offRemote()
    offRunning()
    for (const run of live.values()) run.undo()
    live.clear()
  }
}

/** Every surface there is right now, by kind. The first to name a kind wins,
 *  so a plugin cannot take over one of core's. */
export const surfacesAtom = atom((get): ReadonlyMap<string, Surface> => {
  const byKind = new Map<string, Surface>()
  for (const c of get(contributionsAtom)) {
    for (const s of c.surfaces ?? []) if (!byKind.has(s.kind)) byKind.set(s.kind, s)
  }
  return byKind
})

/** How each tab of a surface with `tabs` looks now, by surface and id. */
export const surfaceTabLooksAtom = atom(
  (get): ReadonlyMap<string, ReadonlyMap<string, SurfaceTabLook>> =>
    new Map(
      [...get(surfacesAtom).values()].flatMap((s) =>
        s.tabs === undefined
          ? []
          : [[s.kind, new Map(get(s.tabs).map((look) => [look.id, look]))] as const],
      ),
    ),
)

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
  (
    get,
  ): readonly (RailItem & { of: Surface; instances?: readonly string[]; running: boolean })[] => {
    const surfaces = get(surfacesAtom)
    return get(contributionsAtom)
      .flatMap((c) => c.rail ?? [])
      .flatMap((item) => {
        const of = surfaces.get(item.surface)
        if (of === undefined || (item.visible !== undefined && !get(item.visible))) return []
        const running = item.live !== undefined && get(item.live)
        if (of.instances === undefined) return [{ ...item, of, running }]
        const instances = get(of.instances)
        return instances.length === 0 ? [] : [{ ...item, of, instances, running }]
      })
      .sort((a, b) => a.order - b.order)
  },
)
