/**
 * Runs the installed plugins (docs/architecture.md, Plugins).
 *
 * A plugin runs in a vault when the vault's settings enable it
 * (`resolvePlugins`). The host answers that question for dispatch, which
 * refuses a disabled plugin's capabilities, and for the seeder, which writes
 * only enabled plugins' files. And it keeps what is started in step with it:
 * `reconcile` starts what the open vault runs and stops what it no longer
 * does, at the open, on a settings write and on any change to the files (a
 * hand edit). A plugin it requires starts first and stops last. Each vault is
 * its own world: leaving one stops every plugin, so nothing started in one
 * vault carries into the next.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  pluginLabels,
  resolvePlugins,
  type PluginResolution,
  type ResolvedVaultSettings,
} from '@holi/shared'
import type { AppDoor, AppDoorOpener } from '../capabilities/dispatch'
import type { CapabilityRegistry } from '../capabilities/registry'
import type {
  AppCtx,
  BridgeRoute,
  Disposer,
  LiveVault,
  MainPlugin,
  NoteMention,
  Notice,
  PluginCtx,
  QuitQuestion,
  UiReport,
} from '../plugin-api'
import type { ActiveVault } from '../vault/active-vault'
import type { ScanClaim } from '../vault/vault-store'
import type { Transform } from '../vault/hooks/runner'
import { pluginEvents, type PluginEventsDeps } from './events'
import { ensureSeeded, withoutOwned } from '../vault/seed/seed'
import type { SeedContribution, SeedResult } from '../vault/seed/types'
import { readVaultSettings } from '../vault/settings'

/** The open vault, as far as a plugin's `PluginCtx` drives it. */
export type OpenVault = LiveVault &
  Pick<ActiveVault, 'pause' | 'resume' | 'commitNow'> & {
    repo: Pick<ActiveVault['repo'], 'head'>
  }

export interface PluginHostDeps {
  plugins: readonly MainPlugin[]
  registry: Pick<CapabilityRegistry, 'register'>
  userData: string
  /** What core seeds into every vault, ahead of any plugin. */
  coreSeeds: readonly SeedContribution[]
  /** The running Holi's version, recorded when seeding writes shipped files. */
  release?: string
  /** The open vault, whose answer is cached; null with none open. */
  active(): OpenVault | null
  /** The clone of the vault `remote` names, open or not; null for none. */
  rootFor(remote: string): Promise<string | null>
  /** The window and `ipcMain`, for plugin events. */
  events: PluginEventsDeps
  /** The capability host's app door, which one plugin opens and the host
   *  closes when that plugin stops. */
  openAppDoor(opener: AppDoorOpener): AppDoor
  /** Serve a path on the bridge. Returns the undo. */
  route(path: string, route: BridgeRoute): () => void
  /** Where the `holi` command lives. */
  binDir(): string
  /** The signed-in GitHub token, or null. */
  githubToken(): string | null
  /** Confine frames on `origin` to it (`window-guard.ts`). Returns the undo. */
  frameOrigin(origin: string): () => void
  /** A native notification, raised only while no Holi window has focus
   *  (`PluginCtx.notify`). */
  notify(notice: Notice): boolean
  /** Whether a Holi window has focus. */
  focused(): boolean
  readSettings?: (root: string) => Promise<ResolvedVaultSettings>
  /**
   * Plugins' work across vaults (`MainPlugin.background`): the vaults this
   * machine has registered, what a background context offers beyond them,
   * and who hears which plugins run in the background now (the tray and the
   * keep-alive). Absent, as in most tests, nothing runs in the background.
   */
  background?: Omit<AppCtx, 'userData' | 'vaults'> & {
    registered(): Promise<LiveVault[]>
    onChange(whys: readonly string[]): void
  }
}

export interface PluginHost {
  /** The plugins the vault at `root` runs. Cached for the open vault. */
  enabled(root: string): Promise<ReadonlySet<string>>
  /** What the scanner claims in the vault at `root`: its enabled plugins'.
   *  Cached for the open vault, like `enabled`. */
  scanClaimsFor(root: string): Promise<ScanClaim[]>
  /** The commit transforms of the plugins the vault at `root` runs, each
   *  with its default from its toggle. */
  transformsFor(root: string): Promise<(Transform & { default: boolean })[]>
  /** Seed the vault at `root`: core's contributions and its enabled plugins'. */
  seed(root: string): Promise<SeedResult>
  /** Every contribution that seeds the vault at `root`, for `holi skills update`. */
  contributions(root: string): Promise<SeedContribution[]>
  /**
   * Start what the open vault runs and stop what it no longer does, in
   * dependency order; with no vault open, stop everything. `why` is what
   * prompted it: an `open` (after `host.open`, which seeded), a `settings`
   * write, or a `snapshot` (any change to the files, a hand edit to the
   * settings among them). A plugin joining on a write or a snapshot is
   * seeded first. One that failed to start is tried again on an open or a
   * write, or when what the vault runs changes, never on a bare snapshot.
   * Runs one at a time.
   */
  reconcile(why: 'open' | 'settings' | 'snapshot'): Promise<void>
  /** Stop every plugin, newest first, while the vault is still the open one:
   *  when Holi leaves it, and at quit. */
  stop(): Promise<void>
  /** Why each plugin the open vault `remote` runs did not start, by id. */
  failures(remote: string): Record<string, string>
  /** What the renderer reports about the vault `remote`. */
  report(remote: string, report: UiReport): void
  /** A pull brought comments into the vault `remote` that mention the person. */
  mentioned(remote: string, mentions: readonly NoteMention[]): void
  /** The questions the started plugins' quit guards ask right now. */
  quitQuestions(): QuitQuestion[]
  /** The open vault's settings files may have changed on disk. */
  invalidate(): void
  /**
   * Start each plugin's work across vaults that some registered vault runs
   * and stop the rest, then tell `background.onChange` what runs. At launch,
   * and again after anything that may change it: a settings write, an open,
   * or a change to what the open vault runs. Runs one at a time.
   */
  syncBackground(): Promise<void>
  /** Stop every plugin's work across vaults: at quit. */
  stopBackground(): Promise<void>
}

/** One plugin started in the open vault. */
interface Started {
  id: string
  dispose: Disposer
  /** What it registered through its context and has not undone yet,
   *  undone after its disposer. */
  undos: Set<() => void>
}

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const infos = deps.plugins.map((p) => p.info)
  const readSettings = deps.readSettings ?? readVaultSettings
  const quitGuards = new Set<() => QuitQuestion | null>()
  /** The vault plugins are started in, and what is started, in start order. */
  let live: { remote: string; root: string; started: Started[] } | null = null
  /** Why a plugin did not start in the live vault, by id. */
  const failed = new Map<string, string>()
  /** What the live vault ran when its failures were last tried. */
  let lastWant = ''
  /** One reconcile or stop at a time. */
  let queue: Promise<void> = Promise.resolve()
  /** The vault `stop` stopped, which only its next open starts again: a
   *  change landing while Holi leaves it must not restart anything. */
  let parked: string | null = null
  const reportListeners = new Set<{ remote: string; cb: (report: UiReport) => void }>()
  const mentionListeners = new Set<{ remote: string; cb: (mention: NoteMention) => void }>()
  /** The open vault's sync holds, and the vault they hold. */
  let holds: { remote: string; reasons: Map<symbol, string> } | null = null

  let cache: { root: string; enabled: ReadonlySet<string> } | null = null
  // Bumped on every invalidation, so a read that raced one is not cached.
  let generation = 0

  /** Read off disk, and cache it when it is the open vault's. */
  async function read(root: string): Promise<PluginResolution> {
    const at = generation
    const resolution = resolvePlugins((await readSettings(root)).plugins, infos)
    if (at === generation && root === deps.active()?.root) {
      cache = { root, enabled: resolution.running }
    }
    return resolution
  }

  function forget(): void {
    generation += 1
    cache = null
  }

  async function enabled(root: string): Promise<ReadonlySet<string>> {
    if (cache !== null && cache.root === root && root === deps.active()?.root) return cache.enabled
    return (await read(root)).running
  }

  /** The plugins working across vaults now, by id, in start order. */
  const inBackground = new Map<string, { why: string; dispose: Disposer }>()
  let backgroundQueue: Promise<void> = Promise.resolve()

  /** The registered vaults that run `plugin`. */
  async function vaultsRunning(plugin: MainPlugin): Promise<LiveVault[]> {
    const all = (await deps.background?.registered()) ?? []
    const runs = await Promise.all(
      all.map(async (v) => {
        const running = await read(v.root).then(
          (r) => r.running.has(plugin.info.id),
          () => false,
        )
        return running ? [v] : []
      }),
    )
    return runs.flat()
  }

  async function syncBackgroundNow(): Promise<void> {
    const bg = deps.background
    if (bg === undefined) return
    for (const plugin of deps.plugins) {
      const work = plugin.background
      if (work === undefined) continue
      const id = plugin.info.id
      const wanted = (await vaultsRunning(plugin)).length > 0
      const running = inBackground.get(id)
      if (!wanted && running !== undefined) {
        inBackground.delete(id)
        await Promise.resolve()
          .then(running.dispose)
          .catch((err) => console.error(`[plugins] ${id} background stop failed:`, err))
      } else if (wanted && running === undefined) {
        const ctx: AppCtx = {
          userData: deps.userData,
          vaults: () => vaultsRunning(plugin),
          scan: bg.scan,
          open: bg.open,
          viewerLogin: bg.viewerLogin,
          notify: bg.notify,
        }
        try {
          inBackground.set(id, { why: work.why, dispose: await work.start(ctx) })
        } catch (err) {
          console.error(`[plugins] ${id} did not start in the background:`, err)
        }
      }
    }
    bg.onChange([...inBackground.values()].map((b) => b.why))
  }

  function queuedBackground(job: () => Promise<void>): Promise<void> {
    const run = backgroundQueue.then(job, job)
    backgroundQueue = run.catch((err) => console.error('[plugins] background failed:', err))
    return run
  }

  /** What runs in a vault with `enabled` on. */
  const running = (enabled: ReadonlySet<string>): MainPlugin[] =>
    deps.plugins.filter((p) => enabled.has(p.info.id))

  const eventsOf = new Map<string, ReturnType<typeof pluginEvents>>()
  function events(id: string): ReturnType<typeof pluginEvents> {
    let made = eventsOf.get(id)
    if (made === undefined) {
      // Asked per event, a terminal's every chunk: the open vault's answer is
      // the cached one. Core parts are not gated.
      const runs = async (remote: string): Promise<boolean> => {
        const root = await deps.rootFor(remote)
        return root !== null && (await enabled(root)).has(id)
      }
      made = pluginEvents(deps.events, id, runs)
      eventsOf.set(id, made)
    }
    return made
  }

  /** What seeds the vault at `root`, read fresh: a write to its settings
   *  seeds before the watcher has said anything. */
  async function seeding(root: string) {
    const { running: enabled, addingTo } = await read(root)
    // What an owner holds (the agent's `.claude/`) waits for it: core's part
    // there until it runs, a plugin's until it is adding to it (`addsTo`).
    const owned = deps.plugins.flatMap((p) =>
      (p.seed?.owns ?? []).map((prefix) => ({ id: p.info.id, prefix })),
    )
    const outside = (id: string, adding: readonly string[]) =>
      owned.filter((o) => o.id !== id && !adding.includes(o.id)).map((o) => o.prefix)
    const contributions = [
      ...deps.coreSeeds.map((c) => withoutOwned(c, outside(c.id, [...enabled]))),
      ...deps.plugins.flatMap((p) =>
        enabled.has(p.info.id) && p.seed !== undefined
          ? [withoutOwned(p.seed, outside(p.info.id, addingTo.get(p.info.id) ?? []))]
          : [],
      ),
    ]
    return {
      contributions,
      seedArgs: [contributions, [...enabled], deps.release] as [
        SeedContribution[],
        string[],
        string | undefined,
      ],
    }
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

  /** What runs in the vault, providers before what requires them; otherwise
   *  in list order. Core parts first: nothing requires them. */
  function startOrder(want: ReadonlySet<string>): MainPlugin[] {
    const byId = new Map(deps.plugins.map((p) => [p.info.id, p]))
    const ordered: MainPlugin[] = []
    const placed = new Set<string>()
    const place = (p: MainPlugin): void => {
      if (placed.has(p.info.id) || !want.has(p.info.id)) return
      placed.add(p.info.id)
      for (const id of p.info.requires ?? []) {
        const provider = byId.get(id)
        if (provider !== undefined) place(provider)
      }
      ordered.push(p)
    }
    deps.plugins.forEach(place)
    return ordered
  }

  /** Start `plugin` in `vault`; null when it threw, with what it registered
   *  undone and why kept in `failed`. */
  async function start(plugin: MainPlugin, vault: LiveVault): Promise<Started | null> {
    const id = plugin.info.id
    const undos = new Set<() => void>()
    // Each undo runs once, and leaves the set when it does: a sync hold taken
    // every turn must not pile up for the life of the vault.
    const keep = (undo: () => void): (() => void) => {
      const once = (): void => {
        if (!undos.delete(once)) return
        undo()
      }
      undos.add(once)
      return once
    }
    const { remote, root } = vault
    const open = (): OpenVault => {
      const now = deps.active()
      if (now === null || now.remote !== remote) throw new Error(`${remote} is not open`)
      return now
    }
    const ctx: PluginCtx = {
      remote,
      root,
      userData: deps.userData,
      active: deps.active,
      register: (namespaces, table) => keep(deps.registry.register(namespaces, table, id)),
      emit: events(id).emit,
      on: (name, handler) => keep(events(id).on(name, handler)),
      openAppDoor: (opener) => {
        const door = deps.openAppDoor(opener)
        keep(() => door.close())
        return door
      },
      guardQuit: (check) => {
        quitGuards.add(check)
        return keep(() => void quitGuards.delete(check))
      },
      route: (path, route) => keep(deps.route(path, route)),
      binDir: deps.binDir,
      githubToken: deps.githubToken,
      frameOrigin: (origin) => keep(deps.frameOrigin(origin)),
      pauseSync: (reason) => keep(pauseSync(remote, reason)),
      commitNow: async () => open().commitNow(),
      head: async () => open().repo.head(),
      onReport: (cb) => {
        const entry = { remote, cb }
        reportListeners.add(entry)
        return keep(() => void reportListeners.delete(entry))
      },
      onMention: (cb) => {
        const entry = { remote, cb }
        mentionListeners.add(entry)
        return keep(() => void mentionListeners.delete(entry))
      },
      notify: deps.notify,
      focused: deps.focused,
    }
    if (plugin.activate === undefined) return { id, dispose: () => {}, undos }
    try {
      return { id, dispose: await plugin.activate(ctx), undos }
    } catch (err) {
      console.error(`[plugins] ${id} did not start:`, err)
      failed.set(id, err instanceof Error ? err.message : String(err))
      undoAll(id, undos)
      return null
    }
  }

  function undoAll(id: string, undos: ReadonlySet<() => void>): void {
    for (const undo of [...undos].reverse()) {
      try {
        undo()
      } catch (err) {
        console.error(`[plugins] ${id} undo failed:`, err)
      }
    }
  }

  /** Its disposer, then what it registered. */
  async function stopOne(s: Started): Promise<void> {
    await Promise.resolve()
      .then(s.dispose)
      .catch((err) => console.error(`[plugins] ${s.id} stop failed:`, err))
    undoAll(s.id, s.undos)
  }

  async function stopAll(): Promise<void> {
    const was = live
    live = null
    failed.clear()
    lastWant = ''
    for (const s of [...(was?.started ?? [])].reverse()) await stopOne(s)
    reportListeners.clear()
    mentionListeners.clear()
    holds = null
  }

  async function reconcileNow(why: 'open' | 'settings' | 'snapshot'): Promise<void> {
    const vault = deps.active()
    if (vault === null) return stopAll()
    if (why === 'open') parked = null
    else if (vault.remote === parked) return
    if (live !== null && live.remote !== vault.remote) await stopAll()
    const { remote, root } = vault
    const here = live ?? { remote, root, started: [] }
    live = here
    const want = (await read(root)).running
    // Left while it read: the leave stops what is here.
    if (live !== here || deps.active()?.remote !== remote) return
    const wantKey = [...want].sort().join(' ')
    if (why !== 'snapshot' || wantKey !== lastWant) {
      failed.clear()
      // What runs across vaults follows the same writes.
      void queuedBackground(syncBackgroundNow)
    }
    lastWant = wantKey

    // What left, dependents first: the start order, backwards.
    for (const s of [...here.started].reverse()) {
      if (want.has(s.id)) continue
      here.started = here.started.filter((x) => x !== s)
      await stopOne(s)
    }

    const isStarted = (id: string): boolean => here.started.some((s) => s.id === id)
    const joining = startOrder(want).filter((p) => !isStarted(p.info.id) && !failed.has(p.info.id))
    if (joining.length === 0) return
    // The open seeded before the vault opened, so nothing could be committed
    // ahead of its `.gitignore`.
    if (why !== 'open') {
      await ensureSeeded(root, ...(await seeding(root)).seedArgs).catch((err) =>
        console.error('[plugins] seed failed:', err),
      )
    }
    for (const plugin of joining) {
      if (live !== here || deps.active()?.remote !== remote) return
      const id = plugin.info.id
      const down = (plugin.info.requires ?? []).filter((r) => !isStarted(r))
      if (down.length > 0) {
        failed.set(id, `${pluginLabels(down, infos)} did not start.`)
        continue
      }
      const s = await start(plugin, vault)
      // Left while it started: stop it again rather than leave it running.
      if (live !== here) {
        if (s !== null) await stopOne(s)
        return
      }
      if (s !== null) here.started.push(s)
    }
  }

  /** Run `job` after whatever reconcile or stop is under way. */
  function queued(job: () => Promise<void>): Promise<void> {
    const run = queue.then(job, job)
    queue = run.catch((err) => console.error('[plugins] reconcile failed:', err))
    return run
  }

  return {
    enabled,

    transformsFor: async (root) =>
      running(await enabled(root)).flatMap((p) =>
        (p.transforms ?? []).map((t) => ({
          ...t,
          default: (p.info.transforms ?? []).find((x) => x.name === t.name)?.default ?? false,
        })),
      ),

    scanClaimsFor: async (root) =>
      running(await enabled(root)).flatMap((p) =>
        (p.claims ?? []).map((claim) => ({ ...claim, plugin: p.info.id })),
      ),

    contributions: async (root) => (await seeding(root)).contributions,

    async seed(root) {
      return ensureSeeded(root, ...(await seeding(root)).seedArgs)
    },

    reconcile: (why) => queued(() => reconcileNow(why)),

    async stop() {
      parked = deps.active()?.remote ?? null
      await queued(stopAll)
      forget()
    },

    failures: (remote) => (live?.remote === remote ? Object.fromEntries(failed) : {}),

    invalidate: forget,

    syncBackground: () => queuedBackground(syncBackgroundNow),

    stopBackground: () =>
      queuedBackground(async () => {
        for (const [id, b] of [...inBackground].reverse()) {
          inBackground.delete(id)
          await Promise.resolve()
            .then(b.dispose)
            .catch((err) => console.error(`[plugins] ${id} background stop failed:`, err))
        }
        deps.background?.onChange([])
      }),

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

    mentioned(remote, mentions) {
      for (const { remote: at, cb } of [...mentionListeners]) {
        if (at !== remote) continue
        for (const mention of mentions) {
          try {
            cb(mention)
          } catch (err) {
            console.error('[plugins] mention listener failed:', err)
          }
        }
      }
    },

    quitQuestions: () =>
      [...quitGuards].flatMap((check) => {
        const question = check()
        return question === null ? [] : [question]
      }),
  }
}
