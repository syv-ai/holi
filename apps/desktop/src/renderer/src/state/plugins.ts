/**
 * The plugins this build has, and which of them the open vault runs
 * (docs/architecture.md, Plugins).
 *
 * `main.tsx` installs the list once at boot; nothing else in core imports a
 * plugin. Which ones run follows the vault's `plugins` setting, through the
 * same resolver main uses (`resolvePlugins`), so the two cannot disagree.
 *
 * Core's own surfaces, rail items and claims are installed the same way
 * (`coreContributionAtom`), beside the plugins': they render features, which
 * state does not import.
 */
import { atom, type Atom, type createStore } from 'jotai'
import {
  resolvePlugins,
  type PluginResolution,
  knownTransforms,
  vaultSettingDescriptors,
  VAULT_SETTING_DEFAULTS,
} from '@holi/shared'
import { folderClaims, type FolderDocumentClaim } from '@/state/folder-documents'
import type {
  AgentServiceSource,
  CommandMenuEntry,
  PathClaim,
  RendererPlugin,
  SlashCommand,
  Surface,
} from '@/state/plugin-types'
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
type CoreContribution = Pick<Required<RendererPlugin>, 'surfaces' | 'rail'> & {
  claims: readonly PathClaim[]
}

/** @public exported for its test */
export const coreContributionAtom = atom<CoreContribution>({ surfaces: [], rail: [], claims: [] })

/** Which plugins the open vault runs and why each other one does not. Each
 *  plugin's default until its settings are read.
 * @public exported for its test
 */
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

/** Every enabled plugin, in list order. */
export const runningPluginsAtom = atom((get): readonly RendererPlugin[] => {
  const enabled = get(enabledPluginsAtom)
  return get(installedPluginsAtom).filter((p) => enabled.has(p.info.id))
})

/** What the running plugins add to the document editor's slash menu, in
 *  list order (`RendererPlugin.slashCommands`). */
export const pluginSlashCommandsAtom = atom((get): readonly SlashCommand[] =>
  get(runningPluginsAtom).flatMap((p) =>
    p.slashCommands === undefined ? [] : get(p.slashCommands),
  ),
)

/** Every running plugin's commands, in list order. */
export const pluginCommandsAtom = atom((get): readonly Command[] =>
  get(runningPluginsAtom).flatMap((p) => p.commands ?? []),
)

/** What running plugins add to the ⌘K command menu, each with its plugin's
 *  id (`RendererPlugin.commandMenu`). */
export const commandMenuEntriesAtom = atom(
  (get): readonly (CommandMenuEntry & { plugin: string })[] =>
    get(runningPluginsAtom).flatMap((p) =>
      p.commandMenu === undefined
        ? []
        : get(p.commandMenu.entries).map((entry) => ({ ...entry, plugin: p.info.id })),
    ),
)

/** Run a command menu row through the plugin that added it. */
export const runCommandMenuEntryAtom = atom(
  null,
  (get, set, { plugin, id }: { plugin: string; id: string }): void => {
    const run = get(runningPluginsAtom).find((p) => p.info.id === plugin)?.commandMenu?.run
    if (run !== undefined) set(run, id)
  },
)

/** Core's contribution, then every running plugin's, in list order. */
const contributionsAtom = atom((get): readonly Pick<RendererPlugin, 'surfaces' | 'rail'>[] => [
  get(coreContributionAtom),
  ...get(runningPluginsAtom),
])

/** What stopping each running plugin would cost now, by id: its
 *  `leaveGuard` sentence, for one that says something. */
export const leaveReasonByPluginAtom = atom((get): ReadonlyMap<string, string> => {
  const reasons = new Map<string, string>()
  for (const p of get(runningPluginsAtom)) {
    const reason = p.leaveGuard === undefined ? null : get(p.leaveGuard)
    if (reason !== null) reasons.set(p.info.id, reason)
  }
  return reasons
})

/** Why leaving the open vault costs something now: every running plugin's
 *  `leaveGuard` sentence. Empty when leaving costs nothing. */
export const leaveReasonsAtom = atom((get): readonly string[] => [
  ...get(leaveReasonByPluginAtom).values(),
])

/** The first running plugin that provides an agent, or null with none. */
const agentProviderAtom = atom(
  (get): RendererPlugin | null =>
    get(runningPluginsAtom).find((p) => p.agent !== undefined) ?? null,
)

/** The first running plugin's agent, or null with none. */
export const agentSourceAtom = atom(
  (get): AgentServiceSource | null => get(agentProviderAtom)?.agent ?? null,
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
