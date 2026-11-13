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
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  pluginLabels,
  resolvePlugins,
  type PluginResolution,
  type ResolvedVaultSettings,
  type VaultEvent,
  type VaultSnapshot,
} from '@holi/shared'
import type { BrowserWindow } from 'electron'
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
import type { ActivityWrite } from '../activity/log'

/**
 * The open vault, as far as a plugin's `PluginCtx` drives it.
 * @public exported for its test
 */
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
  openAppDoor(opener: AppDoorOpener, remote: string): AppDoor
  /** Serve a path on the bridge. Returns the undo. */
  route(path: string, route: BridgeRoute, remote: string): () => void
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
  /** Holi's window, or null with none open. Absent, as in most tests, it is
   *  null. */
  window?: () => BrowserWindow | null
  readSettings?: (root: string) => Promise<ResolvedVaultSettings>
  /** One capability call at the UI door in the vault `remote`, for
   *  `ctx.call`. Absent, a call is refused. */
  call?: (
    remote: string,
    name: string,
    params: unknown,
    beforeInvoke?: (target: { remote: string; root: string }) => Promise<void>,
  ) => Promise<unknown>
  /** The activity log (`activity/log.ts`), for `ctx.log` and for a plugin
   *  that would not start. Absent, as in most tests, lines are dropped. */
  activity?: ActivityWrite
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
  /**
   * The plugins whose capabilities and events are open in the vault at
   * `root`: what it runs, and a plugin of the open vault until its disposer
   * has finished. Turning a plugin off writes the setting first, so without
   * the second its disposer could neither tell its renderer nor hear back
   * (a meeting's last audio, docs/features/meetings.md).
   */
  serving(root: string): Promise<ReadonlySet<string>>
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
   * Reconcile the explicitly supplied vault's plugins and stop what it no
   * longer enables, in dependency order. `why` is what
   * prompted it: an `open` (after `host.open`, which seeded), a `settings`
   * write, or a `snapshot` (any change to the files, a hand edit to the
   * settings among them). A plugin joining on a write or a snapshot is
   * seeded first. One that failed to start is tried again on an open or a
   * write, or when what the vault runs changes, never on a bare snapshot.
   * Calls for one remote are serialized; different remotes proceed independently.
   */
  reconcile(vault: OpenVault, why: 'open' | 'settings' | 'snapshot'): Promise<void>
  /** Stop a remote while its vault remains available to draining disposers. */
  stop(remote: string): Promise<void>
  /** Stop all remote lifetimes, newest first within each vault. */
  stopAll(): Promise<void>
  /** The renderer's currently displayed remote; independent of running lifetimes. */
  displayed(): string | null
  setDisplayed(remote: string | null): void
  onDisplayChange(cb: (remote: string | null) => void): () => void
  /** Why each plugin the open vault `remote` runs did not start, by id. */
  failures(remote: string): Record<string, string>
  /** What the renderer reports about the vault `remote`. */
  report(remote: string, report: UiReport): void
  /** A pull brought comments into the vault `remote` that mention the person. */
  mentioned(remote: string, mentions: readonly NoteMention[]): void
  /** A fresh scan of the vault `remote`, for the plugins started in it. */
  snapshot(remote: string, snapshot: VaultSnapshot): void
  /** The questions the started plugins' quit guards ask right now. */
  quitQuestions(): QuitQuestion[]
  /** The open vault's settings files may have changed on disk. */
  invalidate(remote?: string): void
  /**
   * Start each plugin's work across vaults that some registered vault runs
   * and stop the rest, then tell `background.onChange` what runs. At launch,
   * and again after anything that may change it: a settings write, an open,
   * a change to what the open vault runs, no vault open, or a vault leaving
   * the registry. Runs one at a time.
   */
  syncBackground(): Promise<void>
  /** Stop every plugin's work across vaults: at quit. */
  stopBackground(): Promise<void>
}

/** One plugin started in the open vault. */
interface Started {
  id: string
  dispose: Disposer
  lease: { phase: 'active' | 'draining' | 'closed'; events: ReturnType<typeof pluginEvents> }
  establish(): void
  closeEvents(): void
  /** What it registered through its context and has not undone yet,
   *  undone after its disposer. */
  undos: Set<() => void>
}

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const infos = deps.plugins.map((p) => p.info)
  const readSettings = deps.readSettings ?? readVaultSettings
  const quitGuards = new Set<() => QuitQuestion | null>()
  /** State and serialization belong to a remote, not the displayed window. */
  type VaultRun = {
    vault: OpenVault
    started: Started[]
    failed: Map<string, string>
    lastWant: string
    queue: Promise<void>
    parked: boolean
    generation: number
    holds: { reasons: Map<symbol, string> } | null
    stopping: Map<string, boolean>
    leases: Set<Started['lease']>
  }
  const runsByRemote = new Map<string, VaultRun>()
  const makeRun = (vault: OpenVault): VaultRun => ({
    vault,
    started: [],
    failed: new Map(),
    lastWant: '',
    queue: Promise.resolve(),
    parked: false,
    generation: 0,
    holds: null,
    stopping: new Map(),
    leases: new Set(),
  })
  let displayed: string | null = null
  const displayListeners = new Set<(remote: string | null) => void>()
  const onDisplayChange = (cb: (remote: string | null) => void): (() => void) => {
    displayListeners.add(cb)
    return () => void displayListeners.delete(cb)
  }
  const reportListeners = new Set<{
    remote: string
    generation: number
    cb: (report: UiReport) => void
  }>()
  /** What one plugin's main side tells the plugins that require it
   *  (`publish`/`hear`), by `<from>/<name>`. */
  const heard = new Map<string, Set<(payload: unknown) => void>>()
  const mentionListeners = new Set<{
    remote: string
    generation: number
    cb: (mention: NoteMention) => void
  }>()
  const snapshotListeners = new Set<{
    remote: string
    generation: number
    cb: (s: VaultSnapshot) => void
  }>()
  const snapshots = new Map<string, { snapshot: VaultSnapshot; generation: number }>()
  /** A disposer call may temporarily use established providers, only while
   *  the awaited call is active and its owning disposer lease is draining. */
  type FinalizationOperation = {
    remote: string
    root: string
    state: VaultRun
    ownerLease: Started['lease']
    active: boolean
  }
  const finalizationOperations = new AsyncLocalStorage<FinalizationOperation>()
  const eventListeners = new Set<{
    remote: string
    generation: number
    live(): boolean
    cb: (e: VaultEvent) => void
  }>()
  /** Cached plugin settings are keyed by vault root. */
  const cache = new Map<string, ReadonlySet<string>>()
  const cacheVersions = new Map<string, number>()

  /** Read off disk, and cache only if no invalidation raced the read. */
  async function read(root: string): Promise<PluginResolution> {
    const version = cacheVersions.get(root) ?? 0
    cacheVersions.set(root, version)
    const resolution = resolvePlugins((await readSettings(root)).plugins, infos)
    if ((cacheVersions.get(root) ?? 0) === version) cache.set(root, resolution.running)
    return resolution
  }

  function forget(remote?: string): void {
    if (remote === undefined) {
      for (const root of cache.keys()) cacheVersions.set(root, (cacheVersions.get(root) ?? 0) + 1)
      cache.clear()
    } else {
      const state = runsByRemote.get(remote)
      if (state !== undefined) {
        cacheVersions.set(state.vault.root, (cacheVersions.get(state.vault.root) ?? 0) + 1)
        cache.delete(state.vault.root)
      }
    }
  }

  async function enabled(root: string): Promise<ReadonlySet<string>> {
    return cache.get(root) ?? (await read(root)).running
  }

  async function serving(root: string): Promise<ReadonlySet<string>> {
    const on = await enabled(root)
    const state = [...runsByRemote.values()].find((run) => run.vault.root === root)
    const going = [
      ...(state?.started.map((s) => s.id) ?? []),
      ...(state === undefined ? [] : [...state.stopping.keys()]),
    ].filter((id) => !on.has(id))
    return going.length === 0 ? on : new Set([...on, ...going])
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

  function events(
    id: string,
    remote: string,
    root: string,
    isLive: () => boolean,
  ): ReturnType<typeof pluginEvents> {
    const runs = async (at: string): Promise<boolean> => {
      if (!isLive() || at !== remote) return false
      const registeredRoot = await deps.rootFor(at)
      return registeredRoot === root && (await serving(root)).has(id)
    }
    return pluginEvents(deps.events, id, runs, undefined, isLive)
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

  function pauseSync(vault: OpenVault, state: VaultRun, reason: string): () => void {
    const remote = vault.remote
    const mine = (state.holds ??= { reasons: new Map() })
    const key = Symbol(reason)
    mine.reasons.set(key, reason)
    vault.pause(reason)
    return () => {
      if (!mine.reasons.delete(key)) return
      if (state.holds !== mine || runsByRemote.get(remote) !== state) return
      const still = [...mine.reasons.values()].at(-1)
      if (still === undefined) vault.resume()
      else vault.pause(still)
    }
  }

  /** What runs in the vault, providers before what requires them; otherwise
   *  in list order. */
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
  async function start(
    plugin: MainPlugin,
    vault: OpenVault,
    state: VaultRun,
  ): Promise<Started | null> {
    const id = plugin.info.id
    const activation = state.generation
    let established = false
    let eventsLive = true
    const { remote, root } = vault
    const lease: Started['lease'] = {
      phase: 'active',
      events: events(id, remote, root, () => lease.phase !== 'closed'),
    }
    state.leases.add(lease)
    const eventBus = lease.events
    const valid = (): boolean => lease.phase === 'active' && state.generation === activation
    const draining = (): boolean => lease.phase === 'draining' && established
    const finalizing = (): boolean => {
      const operation = finalizationOperations.getStore()
      return (
        operation !== undefined &&
        operation.active &&
        operation.remote === remote &&
        operation.root === root &&
        operation.state === state &&
        operation.ownerLease.phase === 'draining' &&
        state.leases.has(operation.ownerLease) &&
        state.parked &&
        runsByRemote.get(remote) === state &&
        established &&
        lease.phase === 'active'
      )
    }
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
    const ctx: PluginCtx = {
      remote,
      root,
      userData: deps.userData,
      displayed: () => displayed,
      onDisplayChange: (cb) => {
        if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
        return keep(
          onDisplayChange((at) => {
            if (valid()) cb(at)
          }),
        )
      },
      active: () => vault,
      register: (namespaces, table) => {
        if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
        return keep(deps.registry.register(namespaces, table, id, remote))
      },
      emit: (at, name, payload) => {
        if (valid() || draining()) eventBus.emit(at, name, payload)
      },
      on: (name, handler) => {
        if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
        return keep(
          eventBus.on(name, (at, payload) => {
            if (valid() && eventsLive) handler(at, payload)
          }),
        )
      },
      openAppDoor: (opener) => {
        if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
        const door = deps.openAppDoor(opener, remote)
        keep(() => door.close())
        return door
      },
      guardQuit: (check) => {
        if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
        const guarded = (): QuitQuestion | null => (valid() ? check() : null)
        quitGuards.add(guarded)
        return keep(() => void quitGuards.delete(guarded))
      },
      route: (path, route) => {
        if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
        return keep(deps.route(path, route, remote))
      },
      binDir: deps.binDir,
      githubToken: deps.githubToken,
      frameOrigin: (origin) => {
        if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
        return keep(deps.frameOrigin(origin))
      },
      pauseSync: (reason) => {
        if (!valid()) throw new Error(`${remote} plugin context is no longer active`)
        return keep(pauseSync(vault, state, reason))
      },
      commitNow: async () => {
        if (!valid() && !draining() && !finalizing())
          throw new Error(`${remote} plugin context is no longer active`)
        return vault.commitNow()
      },
      head: async () => {
        if (!valid() && !draining() && !finalizing())
          throw new Error(`${remote} plugin context is no longer active`)
        return vault.repo.head()
      },
      onReport: (cb) => {
        if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
        const entry = {
          remote,
          generation: activation,
          cb: (report: UiReport) => {
            if (valid()) cb(report)
          },
        }
        reportListeners.add(entry)
        return keep(() => void reportListeners.delete(entry))
      },
      call: async (name, params) => {
        if (deps.call === undefined) throw new Error(`no capability calls here: ${name}`)
        const inFinalization = finalizing()
        const admittedDuringDrain = draining() || inFinalization
        if ((!valid() && !admittedDuringDrain) || !eventsLive)
          throw new Error(`${remote} plugin context is no longer active`)
        const inherited = finalizationOperations.getStore()
        const operation =
          inherited !== undefined && inFinalization
            ? inherited
            : draining() && state.parked
              ? { remote, root, state, ownerLease: lease, active: true }
              : null
        const invoke = () =>
          deps.call!(remote, name, params, async (target) => {
            if (
              !eventsLive ||
              target.remote !== remote ||
              target.root !== root ||
              (operation !== null
                ? !operation.active ||
                  operation.remote !== remote ||
                  operation.root !== root ||
                  operation.state !== state ||
                  operation.ownerLease.phase !== 'draining' ||
                  !state.leases.has(operation.ownerLease) ||
                  !state.parked ||
                  runsByRemote.get(remote) !== state ||
                  !(draining() || finalizing())
                : admittedDuringDrain
                  ? !draining()
                  : !valid())
            )
              throw new Error(`${remote} plugin context is no longer active`)
          })
        if (operation === null) return invoke()
        try {
          return await finalizationOperations.run(operation, invoke)
        } finally {
          if (operation !== inherited) operation.active = false
        }
      },
      log: (level, message, detail) => {
        if (!valid() && !draining()) return
        deps.activity?.({
          // The agent's lines are a channel of their own; every other
          // plugin's share one.
          channel: id === 'agent' ? 'agent' : 'plugins',
          level,
          message: id === 'agent' ? message : `${plugin.info.label}: ${message}`,
          remote,
          plugin: id,
          ...(detail === undefined ? {} : { detail }),
        })
      },
      publish: (name, payload) => {
        if ((!valid() && !draining()) || !eventsLive || runsByRemote.get(remote) !== state) return
        for (const handler of heard.get(`${remote}/${id}/${name}`) ?? []) {
          try {
            handler(payload)
          } catch (err) {
            console.error(`[plugins] ${id} ${name}:`, err)
          }
        }
      },
      hear: (from, name, handler) => {
        if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
        // Only what it builds on: a plugin's news is for those that require it.
        if (!(plugin.info.requires ?? []).includes(from)) {
          throw new Error(`${id} hears ${from}, which it does not require`)
        }
        const key = `${remote}/${from}/${name}`
        const set = heard.get(key) ?? new Set()
        heard.set(key, set)
        const guarded = (payload: unknown): void => {
          // Providers remain available to fresh disposer work while their
          // dependants drain, but a stopping listener cannot restart work.
          if (valid() || (state.parked && lease.phase === 'active' && established)) handler(payload)
        }
        set.add(guarded)
        return keep(() => void set.delete(guarded))
      },
      onMention: (cb) => {
        if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
        const entry = {
          remote,
          generation: activation,
          cb: (mention: NoteMention) => {
            if (valid()) cb(mention)
          },
        }
        mentionListeners.add(entry)
        return keep(() => void mentionListeners.delete(entry))
      },
      notify: (notice) => (valid() || draining() ? deps.notify(notice) : false),
      focused: deps.focused,
      window: () => deps.window?.() ?? null,
      onSnapshot: (cb) => {
        if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
        const entry = {
          remote,
          generation: activation,
          cb: (snapshot: VaultSnapshot) => {
            if (valid()) cb(snapshot)
          },
        }
        snapshotListeners.add(entry)
        const held = snapshots.get(remote) ?? null
        if (held !== null && held.generation === state.generation) {
          queueMicrotask(() => {
            if (snapshotListeners.has(entry) && valid() && runsByRemote.get(remote) === state)
              tell(entry.cb, held.snapshot, 'snapshot')
          })
        }
        return keep(() => void snapshotListeners.delete(entry))
      },
      events: {
        // Heard after the emitter's own step, never inside it: a listener that
        // emits back must not re-enter.
        emit: (event) => {
          const admittedDuringDrain = draining()
          if (!valid() && !admittedDuringDrain) return
          const scheduledGeneration = state.generation
          queueMicrotask(() => {
            if (
              runsByRemote.get(remote) !== state ||
              state.generation !== scheduledGeneration ||
              (admittedDuringDrain ? !draining() : !valid())
            )
              return
            for (const l of [...eventListeners]) {
              if (l.remote === remote && l.generation === activation && l.live())
                tell(l.cb, event, 'event')
            }
          })
        },
        on: (cb) => {
          if (!valid()) throw new Error(`${remote} plugin activation was cancelled`)
          const entry = {
            remote,
            generation: activation,
            live: () => lease.phase === 'active',
            cb,
          }
          eventListeners.add(entry)
          return keep(() => void eventListeners.delete(entry))
        },
      },
    }
    if (plugin.activate === undefined)
      return {
        id,
        dispose: () => {},
        lease,
        establish: () => {
          established = true
        },
        closeEvents: () => {
          eventsLive = false
        },
        undos,
      }
    try {
      const dispose = await plugin.activate(ctx)
      return {
        id,
        dispose,
        lease,
        establish: () => {
          established = true
        },
        closeEvents: () => {
          eventsLive = false
        },
        undos,
      }
    } catch (err) {
      lease.phase = 'closed'
      eventBus.cancelPending()
      state.leases.delete(lease)
      eventsLive = false
      console.error(`[plugins] ${id} did not start:`, err)
      state.failed.set(id, err instanceof Error ? err.message : String(err))
      deps.activity?.({
        channel: 'plugins',
        level: 'error',
        message: `${plugin.info.label} did not start`,
        detail: err instanceof Error ? err.message : String(err),
        remote,
        plugin: id,
      })
      undoAll(id, undos)
      return null
    }
  }

  /** Call one listener; its throw is logged, never the caller's. */
  function tell<T>(cb: (value: T) => void, value: T, what: string): void {
    try {
      cb(value)
    } catch (err) {
      console.error(`[plugins] ${what} listener failed:`, err)
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

  /** Its disposer, then what it registered. It is served until both are done. */
  async function stopOne(s: Started, state: VaultRun): Promise<void> {
    state.stopping.set(s.id, true)
    s.lease.events.cancelPending()
    s.lease.phase = 'draining'
    try {
      await Promise.resolve()
        .then(s.dispose)
        .catch((err) => console.error(`[plugins] ${s.id} stop failed:`, err))
      await s.lease.events.drain()
    } finally {
      s.lease.phase = 'closed'
      s.lease.events.cancelPending()
      s.closeEvents()
      undoAll(s.id, s.undos)
      state.leases.delete(s.lease)
      state.stopping.delete(s.id)
    }
  }

  async function stopNow(remote: string, state: VaultRun): Promise<void> {
    state.parked = true
    state.failed.clear()
    state.lastWant = ''
    for (const s of [...state.started].reverse()) {
      state.started = state.started.filter((x) => x !== s)
      await stopOne(s, state)
    }
    for (const entry of reportListeners) if (entry.remote === remote) reportListeners.delete(entry)
    for (const entry of mentionListeners)
      if (entry.remote === remote) mentionListeners.delete(entry)
    for (const entry of snapshotListeners)
      if (entry.remote === remote) snapshotListeners.delete(entry)
    for (const entry of eventListeners) if (entry.remote === remote) eventListeners.delete(entry)
    for (const key of heard.keys()) if (key.startsWith(`${remote}/`)) heard.delete(key)
    snapshots.delete(remote)
    state.holds = null
  }

  async function reconcileNow(
    vault: OpenVault,
    why: 'open' | 'settings' | 'snapshot',
    scheduledGeneration: number,
  ): Promise<void> {
    const { remote, root } = vault
    let state = runsByRemote.get(remote)
    if (state === undefined) {
      state = makeRun(vault)
      runsByRemote.set(remote, state)
    } else {
      state.vault = vault
    }
    if (state.generation !== scheduledGeneration) return
    if (why === 'open') state.parked = false
    else if (state.parked) return
    const activation = state.generation
    const want = (await read(root)).running
    if (runsByRemote.get(remote) !== state || state.generation !== activation || state.parked)
      return
    const wantKey = [...want].sort().join(' ')
    if (why !== 'snapshot' || wantKey !== state.lastWant) {
      state.failed.clear()
      void queuedBackground(syncBackgroundNow)
    }
    state.lastWant = wantKey
    for (const s of [...state.started].reverse()) {
      if (want.has(s.id)) continue
      state.started = state.started.filter((x) => x !== s)
      await stopOne(s, state)
    }
    const isStarted = (id: string): boolean => state.started.some((s) => s.id === id)
    const joining = startOrder(want).filter(
      (p) => !isStarted(p.info.id) && !state.failed.has(p.info.id),
    )
    if (joining.length === 0) return
    if (why !== 'open') {
      await ensureSeeded(root, ...(await seeding(root)).seedArgs).catch((err) =>
        console.error('[plugins] seed failed:', err),
      )
    }
    for (const plugin of joining) {
      if (runsByRemote.get(remote) !== state || state.generation !== activation || state.parked)
        return
      const id = plugin.info.id
      const down = (plugin.info.requires ?? []).filter((r) => !isStarted(r))
      if (down.length > 0) {
        state.failed.set(id, `${pluginLabels(down, infos)} did not start.`)
        continue
      }
      const s = await start(plugin, vault, state)
      if (runsByRemote.get(remote) !== state || state.generation !== activation || state.parked) {
        if (s !== null) await stopOne(s, state)
        return
      }
      if (s !== null) {
        state.started.push(s)
        s.establish()
      }
    }
  }

  function queued(state: VaultRun, job: () => Promise<void>): Promise<void> {
    const run = state.queue.then(job, job)
    state.queue = run.catch((err) =>
      console.error(`[plugins] ${state.vault.remote} reconcile failed:`, err),
    )
    return run
  }

  return {
    enabled,
    serving,

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

    reconcile: (vault, why) => {
      const state = runsByRemote.get(vault.remote) ?? makeRun(vault)
      runsByRemote.set(vault.remote, state)
      state.vault = vault
      const scheduledGeneration = state.generation
      return queued(state, () => reconcileNow(vault, why, scheduledGeneration))
    },

    async stop(remote) {
      const state = runsByRemote.get(remote)
      if (state === undefined) return
      state.generation += 1
      state.parked = true
      for (const lease of state.leases) lease.events.cancelPending()
      cacheVersions.set(state.vault.root, (cacheVersions.get(state.vault.root) ?? 0) + 1)
      cache.delete(state.vault.root)
      await queued(state, () => stopNow(remote, state))
      forget(remote)
    },

    async stopAll() {
      const entries = [...runsByRemote.entries()]
      for (const [, state] of entries) {
        state.generation += 1
        state.parked = true
        for (const lease of state.leases) lease.events.cancelPending()
        cacheVersions.set(state.vault.root, (cacheVersions.get(state.vault.root) ?? 0) + 1)
        cache.delete(state.vault.root)
      }
      await Promise.all(
        entries.map(([remote, state]) => queued(state, () => stopNow(remote, state))),
      )
      cache.clear()
    },

    displayed: () => displayed,
    setDisplayed(remote) {
      if (displayed === remote) return
      displayed = remote
      for (const cb of [...displayListeners]) tell(cb, remote, 'display')
    },
    onDisplayChange,

    failures: (remote) => Object.fromEntries(runsByRemote.get(remote)?.failed ?? []),

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

    snapshot(remote, snapshot) {
      const state = runsByRemote.get(remote)
      if (state === undefined || state.parked) return
      snapshots.set(remote, { snapshot, generation: state.generation })
      for (const { remote: at, generation, cb } of [...snapshotListeners]) {
        if (at === remote && generation === state.generation) tell(cb, snapshot, 'snapshot')
      }
    },

    report(remote, report) {
      const state = runsByRemote.get(remote)
      if (state === undefined || state.parked) return
      for (const { remote: at, generation, cb } of [...reportListeners]) {
        if (at === remote && generation === state.generation) tell(cb, report, 'report')
      }
    },

    mentioned(remote, mentions) {
      const state = runsByRemote.get(remote)
      if (state === undefined || state.parked) return
      for (const { remote: at, generation, cb } of [...mentionListeners]) {
        if (at !== remote || generation !== state.generation) continue
        for (const mention of mentions) tell(cb, mention, 'mention')
      }
    },

    quitQuestions: () =>
      [...quitGuards].flatMap((check) => {
        const question = check()
        return question === null ? [] : [question]
      }),
  }
}
