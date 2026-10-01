/**
 * Runs the installed plugins (docs/architecture.md, Plugins).
 *
 * A plugin runs in a vault when the vault's settings enable it
 * (`enabledPlugins`). The host answers that question for dispatch, which
 * refuses a disabled plugin's capabilities, and for the seeder, which writes
 * only enabled plugins' files. It starts each plugin (`activateApp`) once per
 * process, the first time a vault that enables it is entered, and stops them
 * all at quit. Once a vault is open it activates each plugin the vault runs in
 * it (`activateVault`), and disposes those when the vault is left.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { enabledPlugins, type ResolvedVaultSettings } from '@holi/shared'
import type { AppDoor, AppDoorOpener } from '../capabilities/dispatch'
import type { CapabilityRegistry } from '../capabilities/registry'
import type {
  AppContext,
  BridgeRoute,
  Disposer,
  LiveVault,
  MainPlugin,
  QuitQuestion,
  UiReport,
  VaultCtx,
} from '../plugin-api'
import type { ActiveVault } from '../vault/active-vault'
import type { ScanClaim } from '../vault/vault-store'
import { pluginEvents, type PluginEventsDeps } from './events'
import { ensureSeeded, withoutOwned } from '../vault/seed/seed'
import type { SeedContribution, SeedResult } from '../vault/seed/types'
import { readVaultSettings } from '../vault/settings'

/** The open vault, as far as a plugin's `VaultCtx` drives it. */
export type OpenVault = LiveVault &
  Pick<ActiveVault, 'pause' | 'resume' | 'commitNow'> & {
    repo: Pick<ActiveVault['repo'], 'head'>
  }

export interface PluginHostDeps {
  plugins: readonly MainPlugin[]
  /**
   * Core parts written to the plugin contract ahead of their move into a
   * plugin. They run in every vault, whatever its settings say, and their
   * capabilities and events are not gated.
   */
  core?: readonly MainPlugin[]
  registry: Pick<CapabilityRegistry, 'register'>
  userData: string
  /** What core seeds into every vault, ahead of any plugin. */
  coreSeeds: readonly SeedContribution[]
  /** The open vault, whose answer is cached; null with none open. */
  active(): OpenVault | null
  /** The clone of the vault `remote` names, open or not; null for none. */
  rootFor(remote: string): Promise<string | null>
  /** The window and `ipcMain`, for plugin events. */
  events: PluginEventsDeps
  /** The capability host's app door, which one plugin opens. */
  openAppDoor(opener: AppDoorOpener): AppDoor
  /** Serve a path on the bridge. Returns the undo. */
  route(path: string, route: BridgeRoute): () => void
  /** Where the `holi` command lives. */
  binDir(): string
  readSettings?: (root: string) => Promise<ResolvedVaultSettings>
}

export interface PluginHost {
  /** The plugins the vault at `root` runs. Cached for the open vault. */
  enabled(root: string): Promise<ReadonlySet<string>>
  /** What the scanner claims in the vault at `root`: core parts' claims,
   *  then its enabled plugins'. Cached for the open vault, like `enabled`. */
  scanClaimsFor(root: string): Promise<ScanClaim[]>
  /** Seed the vault at `root`: core's contributions and its enabled plugins'. */
  seed(root: string): Promise<SeedResult>
  /** Every contribution that seeds the vault at `root`, for `holi skills update`. */
  contributions(root: string): Promise<SeedContribution[]>
  /** A vault is opening, or its settings were just written: start every
   *  plugin it enables that is not running yet. */
  enter(root: string): Promise<void>
  /** The open vault is open: activate every plugin it runs that is not
   *  active in it yet. A no-op with none open. */
  opened(): Promise<void>
  /** The open vault is closing: dispose its activations, newest first, while
   *  it is still the open one. */
  leave(): Promise<void>
  /** What the renderer reports about the vault `remote`. */
  report(remote: string, report: UiReport): void
  /** The questions the started plugins' quit guards ask right now. */
  quitQuestions(): QuitQuestion[]
  /** The open vault's settings files may have changed on disk. */
  invalidate(): void
  /** Stop every started plugin, newest first. At quit, after `leave`. */
  disposeAll(): Promise<void>
}

interface Started {
  dispose: Disposer
  /** The capability registrations made through its context. */
  undos: (() => void)[]
}

/** One plugin active in the open vault. */
interface InVault {
  id: string
  remote: string
  dispose: Promise<Disposer | null>
}

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const infos = deps.plugins.map((p) => p.info)
  const core = deps.core ?? []
  const coreIds = new Set(core.map((p) => p.info.id))
  const readSettings = deps.readSettings ?? readVaultSettings
  const started = new Map<string, Promise<Started | null>>()
  const quitGuards = new Set<() => QuitQuestion | null>()
  /** Activations in the open vault, oldest first. */
  let inVault: InVault[] = []
  const reportListeners = new Set<{ remote: string; cb: (report: UiReport) => void }>()
  /** The open vault's sync holds, and the vault they hold. */
  let holds: { remote: string; reasons: Map<symbol, string> } | null = null

  let cache: { root: string; enabled: Set<string> } | null = null
  // Bumped on every invalidation, so a read that raced one is not cached.
  let generation = 0

  /** Read off disk, and cache it when it is the open vault's. */
  async function read(root: string): Promise<Set<string>> {
    const at = generation
    const enabled = enabledPlugins((await readSettings(root)).plugins, infos)
    if (at === generation && root === deps.active()?.root) cache = { root, enabled }
    return enabled
  }

  function forget(): void {
    generation += 1
    cache = null
  }

  async function enabled(root: string): Promise<ReadonlySet<string>> {
    if (cache !== null && cache.root === root && root === deps.active()?.root) return cache.enabled
    return read(root)
  }

  /** What runs in a vault with `enabled` on: core parts, then plugins. */
  const running = (enabled: ReadonlySet<string>): MainPlugin[] => [
    ...core,
    ...deps.plugins.filter((p) => enabled.has(p.info.id)),
  ]

  const eventsOf = new Map<string, ReturnType<typeof pluginEvents>>()
  function events(id: string): ReturnType<typeof pluginEvents> {
    let made = eventsOf.get(id)
    if (made === undefined) {
      // Asked per event, a terminal's every chunk: the open vault's answer is
      // the cached one. Core parts are not gated.
      const runs = coreIds.has(id)
        ? undefined
        : async (remote: string): Promise<boolean> => {
            const root = await deps.rootFor(remote)
            return root !== null && (await enabled(root)).has(id)
          }
      made = pluginEvents(deps.events, id, runs)
      eventsOf.set(id, made)
    }
    return made
  }

  async function start(plugin: MainPlugin): Promise<Started | null> {
    const id = plugin.info.id
    const undos: (() => void)[] = []
    const keep = (undo: () => void): (() => void) => {
      undos.push(undo)
      return undo
    }
    const ctx: AppContext = {
      userData: deps.userData,
      active: deps.active,
      register: (namespaces, table) =>
        keep(deps.registry.register(namespaces, table, coreIds.has(id) ? undefined : id)),
      emit: events(id).emit,
      on: (name, handler) => keep(events(id).on(name, handler)),
      openAppDoor: deps.openAppDoor,
      guardQuit: (check) => {
        quitGuards.add(check)
        return keep(() => void quitGuards.delete(check))
      },
      route: (path, route) => keep(deps.route(path, route)),
      binDir: deps.binDir,
    }
    if (plugin.activateApp === undefined) return { dispose: () => {}, undos }
    try {
      return { dispose: await plugin.activateApp(ctx), undos }
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
    // What a plugin that is off owns (the agent's `.claude/`) waits for it.
    const off = deps.plugins.flatMap((p) => (enabled.has(p.info.id) ? [] : (p.seed?.owns ?? [])))
    return { enabled, contributions: withoutOwned(contributions, off) }
  }

  /** Start `plugin` for the process, once; null when it failed to start. */
  function ensureStarted(plugin: MainPlugin): Promise<Started | null> {
    let run = started.get(plugin.info.id)
    if (run === undefined) {
      // A failed start is not memoised: the next enter tries again.
      run = start(plugin).then((s) => {
        if (s === null) started.delete(plugin.info.id)
        return s
      })
      started.set(plugin.info.id, run)
    }
    return run
  }

  function pauseSync(remote: string, reason: string): () => void {
    const vault = deps.active()
    if (vault === null || vault.remote !== remote) {
      throw new Error(`pauseSync: ${remote} is not the open vault`)
    }
    if (holds === null || holds.remote !== remote) holds = { remote, reasons: new Map() }
    const mine = holds
    const key = Symbol(reason)
    mine.reasons.set(key, reason)
    vault.pause(reason)
    return () => {
      if (!mine.reasons.delete(key)) return
      const now = deps.active()
      if (holds !== mine || now === null || now.remote !== remote) return
      const still = [...mine.reasons.values()].at(-1)
      if (still === undefined) now.resume()
      else now.pause(still)
    }
  }

  function vaultCtx(id: string, vault: LiveVault): VaultCtx {
    const { remote, root } = vault
    const open = (): OpenVault => {
      const now = deps.active()
      if (now === null || now.remote !== remote) throw new Error(`${remote} is not open`)
      return now
    }
    return {
      remote,
      root,
      pauseSync: (reason) => pauseSync(remote, reason),
      commitNow: async () => open().commitNow(),
      head: async () => open().repo.head(),
      onReport: (cb) => {
        const entry = { remote, cb }
        reportListeners.add(entry)
        return () => void reportListeners.delete(entry)
      },
      emit: (name, payload) => events(id).emit(remote, name, payload),
    }
  }

  async function activateIn(plugin: MainPlugin, vault: LiveVault): Promise<Disposer | null> {
    if ((await ensureStarted(plugin)) === null) return null
    // Left while it started: the next open activates it.
    if (deps.active()?.remote !== vault.remote) return null
    try {
      return await plugin.activateVault!(vaultCtx(plugin.info.id, vault))
    } catch (err) {
      console.error(`[plugins] ${plugin.info.id} did not activate in ${vault.remote}:`, err)
      return null
    }
  }

  async function leaveVault(): Promise<void> {
    const leaving = inVault.reverse()
    inVault = []
    for (const entry of leaving) {
      const dispose = await entry.dispose
      if (dispose === null) continue
      await Promise.resolve()
        .then(dispose)
        .catch((err) => console.error(`[plugins] ${entry.id} leave failed:`, err))
    }
    reportListeners.clear()
    holds = null
  }

  return {
    enabled,

    scanClaimsFor: async (root) =>
      running(await enabled(root)).flatMap((p) =>
        (p.claims ?? []).map((claim) => ({ ...claim, plugin: p.info.id })),
      ),

    contributions: async (root) => (await seeding(root)).contributions,

    async seed(root) {
      const { enabled, contributions } = await seeding(root)
      return ensureSeeded(root, contributions, [...enabled])
    },

    async enter(root) {
      const enabled = await read(root)
      await Promise.all(
        running(enabled)
          .filter((p) => p.activateApp !== undefined)
          .map(ensureStarted),
      )
    },

    async opened() {
      const vault = deps.active()
      if (vault === null) return
      const { remote, root } = vault
      // Another vault's activations are disposed in its leave; any left over
      // belong to a vault that is gone.
      if (inVault.some((e) => e.remote !== remote)) await leaveVault()
      const enabled = await read(root)
      const fresh = running(enabled).filter(
        (p) => p.activateVault !== undefined && !inVault.some((e) => e.id === p.info.id),
      )
      const added = fresh.map((p) => ({
        id: p.info.id,
        remote,
        dispose: activateIn(p, { remote, root }),
      }))
      inVault.push(...added)
      const results = await Promise.all(added.map((e) => e.dispose))
      // One that did not activate is tried again at the next open.
      const failed = new Set(added.filter((_, i) => results[i] === null))
      if (failed.size > 0) inVault = inVault.filter((e) => !failed.has(e))
    },

    async leave() {
      await leaveVault()
      forget()
    },
    invalidate: forget,

    report(remote, report) {
      for (const { remote: at, cb } of [...reportListeners]) {
        if (at !== remote) continue
        try {
          cb(report)
        } catch (err) {
          console.error('[plugins] report listener failed:', err)
        }
      }
    },

    quitQuestions: () =>
      [...quitGuards].flatMap((check) => {
        const question = check()
        return question === null ? [] : [question]
      }),

    async disposeAll() {
      await leaveVault()
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
