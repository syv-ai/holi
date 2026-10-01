/**
 * Runs the installed plugins (docs/architecture.md, Plugins).
 *
 * A plugin runs in a vault when the vault's settings enable it
 * (`enabledPlugins`). The host answers that question for dispatch, which
 * refuses a disabled plugin's capabilities, and for the seeder, which writes
 * only enabled plugins' files. It starts each plugin (`activateApp`) once per
 * process, the first time a vault that enables it is entered, and stops them
 * all at quit.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { enabledPlugins, type ResolvedVaultSettings } from '@holi/shared'
import type { CapabilityRegistry } from '../capabilities/registry'
import type { AppContext, Disposer, MainPlugin } from '../plugin-api'
import { pluginEvents, type PluginEventsDeps } from './events'
import { ensureSeeded } from '../vault/seed/seed'
import type { SeedContribution, SeedResult } from '../vault/seed/types'
import { readVaultSettings } from '../vault/settings'

export interface PluginHostDeps {
  plugins: readonly MainPlugin[]
  registry: Pick<CapabilityRegistry, 'register'>
  userData: string
  /** What core seeds into every vault, ahead of any plugin. */
  coreSeeds: readonly SeedContribution[]
  /** The open vault's clone, whose answer is cached; null with none open. */
  liveRoot(): string | null
  /** The clone of the vault `remote` names, open or not; null for none. */
  rootFor(remote: string): Promise<string | null>
  /** The window and `ipcMain`, for plugin events. */
  events: PluginEventsDeps
  readSettings?: (root: string) => Promise<ResolvedVaultSettings>
}

export interface PluginHost {
  /** The plugins the vault at `root` runs. Cached for the open vault. */
  enabled(root: string): Promise<ReadonlySet<string>>
  /** Seed the vault at `root`: core's contributions and its enabled plugins'. */
  seed(root: string): Promise<SeedResult>
  /** Every contribution that seeds the vault at `root`, for `holi skills update`. */
  contributions(root: string): Promise<SeedContribution[]>
  /** A vault is opening, or its settings were just written: start every
   *  plugin it enables that is not running yet. */
  enter(root: string): Promise<void>
  /** The open vault is closing. */
  leave(): void
  /** The open vault's settings files may have changed on disk. */
  invalidate(): void
  /** Stop every started plugin, newest first. At quit. */
  disposeAll(): Promise<void>
}

interface Started {
  dispose: Disposer
  /** The capability registrations made through its context. */
  undos: (() => void)[]
}

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const infos = deps.plugins.map((p) => p.info)
  const readSettings = deps.readSettings ?? readVaultSettings
  const started = new Map<string, Promise<Started | null>>()

  let cache: { root: string; enabled: Set<string> } | null = null
  // Bumped on every invalidation, so a read that raced one is not cached.
  let generation = 0

  /** Read off disk, and cache it when it is the open vault's. */
  async function read(root: string): Promise<Set<string>> {
    const at = generation
    const enabled = enabledPlugins((await readSettings(root)).plugins, infos)
    if (at === generation && root === deps.liveRoot()) cache = { root, enabled }
    return enabled
  }

  function forget(): void {
    generation += 1
    cache = null
  }

  async function enabled(root: string): Promise<ReadonlySet<string>> {
    if (cache !== null && cache.root === root && root === deps.liveRoot()) return cache.enabled
    return read(root)
  }

  async function start(plugin: MainPlugin): Promise<Started | null> {
    const id = plugin.info.id
    const undos: (() => void)[] = []
    // Asked per event, a terminal's every chunk: the open vault's answer is
    // the cached one.
    const runs = async (remote: string): Promise<boolean> => {
      const root = await deps.rootFor(remote)
      return root !== null && (await enabled(root)).has(id)
    }
    const events = pluginEvents(deps.events, id, runs)
    const ctx: AppContext = {
      userData: deps.userData,
      register: (namespaces, table) => {
        const undo = deps.registry.register(namespaces, table, id)
        undos.push(undo)
        return undo
      },
      emit: events.emit,
      on: (name, handler) => {
        const undo = events.on(name, handler)
        undos.push(undo)
        return undo
      },
    }
    try {
      return { dispose: await plugin.activateApp!(ctx), undos }
    } catch (err) {
      console.error(`[plugins] ${id} did not start:`, err)
      undos.forEach((undo) => undo())
      return null
    }
  }

  /** What seeds the vault at `root`, read fresh: a write to its settings
   *  seeds before the watcher has said anything. */
  async function seeding(root: string) {
    const enabled = await read(root)
    const contributions = [
      ...deps.coreSeeds,
      ...deps.plugins.flatMap((p) =>
        enabled.has(p.info.id) && p.seed !== undefined ? [p.seed] : [],
      ),
    ]
    return { enabled, contributions }
  }

  return {
    enabled,

    contributions: async (root) => (await seeding(root)).contributions,

    async seed(root) {
      const { enabled, contributions } = await seeding(root)
      return ensureSeeded(root, contributions, [...enabled])
    },

    async enter(root) {
      const enabled = await read(root)
      await Promise.all(
        deps.plugins
          .filter((p) => enabled.has(p.info.id) && p.activateApp !== undefined)
          .map((p) => {
            let run = started.get(p.info.id)
            if (run === undefined) {
              // A failed start is not memoised: the next enter tries again.
              run = start(p).then((s) => {
                if (s === null) started.delete(p.info.id)
                return s
              })
              started.set(p.info.id, run)
            }
            return run
          }),
      )
    },

    leave: forget,
    invalidate: forget,

    async disposeAll() {
      const runs = [...started.values()].reverse()
      started.clear()
      for (const run of runs) {
        const s = await run
        if (s === null) continue
        await Promise.resolve()
          .then(s.dispose)
          .catch((err) => console.error('[plugins] dispose failed:', err))
        s.undos.forEach((undo) => undo())
      }
    },
  }
}
