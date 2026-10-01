/**
 * What a vault app, and the agent, can ask Holi for: one registry, every door.
 *
 * **The app door** is the `window.holi` bridge: `postMessage` from the
 * sandboxed frame to `AppFrame`, which forwards into `apps.call`. **The CLI
 * door** is `holi <group> <verb>` over the bridge's loopback port (`bridge/`). **The
 * UI door** is Holi's own renderer, through `cap.run` (`router.ts`), which is
 * how a plugin's renderer reaches its main side. Each
 * capability is written once, with its refusals, and says which doors may
 * reach it, so what an app sees and what the agent can inspect cannot drift.
 *
 * **The allowlist is what was registered.** A door dispatches only into an
 * entry that names it; nothing else in main is reachable by method name.
 * Core and each feature register their own table from the composition root
 * (`main/index.ts`), under the namespaces they own: a name is
 * `<namespace>.<verb>`, and a namespace has exactly one owner.
 *
 * **Refusals live in main**, because the process rendering untrusted app code
 * must not be the one deciding what it may read. An app never names itself: at
 * the app door `ctx.bundle` is the bundle `AppFrame` mounted, and a `bundle`
 * param is ignored. At the CLI door the agent names the bundle.
 *
 * **An app's consent is a field, `appGrant`.** An entry that reads one
 * person's data names the affordance an app must declare and the person
 * approve; the app door's opener supplies the check (`dispatch.ts`), so the
 * entry's owner never imports the apps code that keeps the approvals.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { VaultSnapshot } from '@holi/shared'
import { CapabilityError } from './error'
import type { CoreServices } from './services'

export type Door = 'app' | 'cli' | 'ui'

export interface CapabilityContext {
  remote: string
  /** The vault clone's root on this machine. */
  root: string
  /** The calling app's bundle at the app door; null at every other door. */
  bundle: string | null
  snapshot(): Promise<VaultSnapshot>
  /** What the running app knows beyond the files, for core's entries: one
   *  factory builds these for every door (`services.ts`). A feature's entries
   *  close over their own dependencies instead. */
  core: CoreServices
}

/**
 * How an entry reads as a `holi <namespace> <verb>` command: required at the
 * CLI door, where the bridge resolves argv against it (`bridge/cli.ts`).
 */
export interface CliSpec {
  /** Positional params, in order. A trailing `?` marks an optional one, and
   *  only the last ones may be optional. Any param can also be given as
   *  `--name value`. */
  args: readonly string[]
  /** One line for `holi`'s usage. */
  summary: string
  /** Params given as a bare `--name`, which reads as `'true'`. */
  flags?: readonly string[]
  /** The param a command reads from stdin when it is not given. The bridge
   *  asks for it (428) without running anything, and the script sends stdin
   *  once, so a write never runs on the first leg. */
  stdin?: string
  /** A param that, given, means the command has no body to read, so the
   *  bridge never asks for stdin and the script never waits on it
   *  (`holi google send --draft <id>`). */
  stdinUnless?: string
}

export interface Capability<P = unknown, R = unknown> {
  doors: readonly Door[]
  cli?: CliSpec
  /** Changes the vault, so the open vault's cache is refreshed after it. */
  writes?: true
  /** At the app door, the affordance (`mail`, `calendar`) the calling app
   *  must have declared and the person approved, checked after the params
   *  and before `run`. Other doors do not ask. */
  appGrant?: string
  /** Reads untrusted params, or throws a `CapabilityError('BAD_REQUEST')`. */
  params(raw: unknown): P
  run(ctx: CapabilityContext, params: P): Promise<R>
  /** The CLI's readable form of a result. Absent: pretty JSON. */
  text?(result: R): string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapability = Capability<any, any>

/** One owner's entries, by full name. */
export type CapabilityTable = Readonly<Record<string, AnyCapability>>

/**
 * An entry, with its params' and result's types inferred, and its doors kept
 * as written: the renderer's `capClient` reads them from the table's type to
 * offer only the verbs that open the UI door.
 */
export function cap<P, R, const D extends readonly Door[]>(
  c: Capability<P, R> & { doors: D },
): Capability<P, R> & { doors: D } {
  return c
}

export interface CapabilityResult {
  value: unknown
  text: string
  writes: boolean
}

export interface CliCommand {
  name: string
  cli: CliSpec
}

export interface CapabilityRegistry {
  /** Adds `table`, whose every name must sit under one of `namespaces`, which
   *  no other caller may already own. Throws otherwise. Returns the undo.
   *  `plugin` names the plugin that registered it; core's entries have none. */
  register(namespaces: readonly string[], table: CapabilityTable, plugin?: string): () => void
  has(name: string): boolean
  /** Every entry that opens `door`, by name. */
  names(door: Door): string[]
  /** The plugin an entry belongs to, or null for core's (and unknown names). */
  pluginOf(name: string): string | null
  /** Every entry open at the CLI door, as a command, by name. */
  commands(): CliCommand[]
  /**
   * Run one capability through one door. An unknown name, or one that does
   * not open to this door, is refused as "no such method", which is what it is
   * from where the caller stands. An entry with an `appGrant` runs at the app
   * door only past `admit`, and is refused when there is none.
   */
  run(
    name: string,
    door: Door,
    ctx: CapabilityContext,
    rawParams: unknown,
    admit?: Admit,
  ): Promise<CapabilityResult>
}

/** The app door's consent check: throws a `CapabilityError` to refuse. */
export type Admit = (ctx: CapabilityContext, grant: string) => Promise<void>

/** A name's namespace, or null for a name that is not `<namespace>.<verb>`. */
const namespaceOf = (name: string): string | null => {
  const dot = name.indexOf('.')
  return dot <= 0 || dot === name.length - 1 ? null : name.slice(0, dot)
}

export function createCapabilityRegistry(): CapabilityRegistry {
  const owners = new Map<string, CapabilityTable>()
  const entries = new Map<string, AnyCapability>()
  const plugins = new Map<string, string>()

  return {
    register(namespaces, table, plugin) {
      for (const ns of namespaces) {
        if (owners.has(ns)) throw new Error(`capability namespace ${ns} is already registered`)
      }
      for (const [name, entry] of Object.entries(table)) {
        const ns = namespaceOf(name)
        if (ns === null || !namespaces.includes(ns)) {
          throw new Error(`capability ${name} is outside its owner's namespaces`)
        }
        if (entry.doors.includes('cli') !== (entry.cli !== undefined)) {
          throw new Error(
            `capability ${name} must say how it reads at the CLI door, and only there`,
          )
        }
        const optional = entry.cli?.args.findIndex((a) => a.endsWith('?')) ?? -1
        if (optional >= 0 && entry.cli!.args.slice(optional).some((a) => !a.endsWith('?'))) {
          throw new Error(`capability ${name} has a required argument after an optional one`)
        }
      }
      for (const ns of namespaces) owners.set(ns, table)
      for (const [name, entry] of Object.entries(table)) {
        entries.set(name, entry)
        if (plugin !== undefined) plugins.set(name, plugin)
      }
      return () => {
        for (const ns of namespaces) if (owners.get(ns) === table) owners.delete(ns)
        for (const [name, entry] of Object.entries(table)) {
          if (entries.get(name) === entry) {
            entries.delete(name)
            plugins.delete(name)
          }
        }
      }
    },

    has: (name) => entries.has(name),

    names: (door) =>
      [...entries].flatMap(([name, entry]) => (entry.doors.includes(door) ? [name] : [])),

    pluginOf: (name) => plugins.get(name) ?? null,

    commands: () =>
      [...entries]
        .flatMap(([name, entry]) => (entry.cli === undefined ? [] : [{ name, cli: entry.cli }]))
        .sort((a, b) => a.name.localeCompare(b.name)),

    async run(name, door, ctx, rawParams, admit) {
      const entry = entries.get(name)
      if (entry === undefined || !entry.doors.includes(door)) {
        throw new CapabilityError('BAD_REQUEST', `no such method: ${name}`)
      }
      const params = entry.params(rawParams)
      if (door === 'app' && entry.appGrant !== undefined) {
        // Fails closed: an app door with no consent check reaches no entry
        // that needs one.
        if (admit === undefined) throw new CapabilityError('BAD_REQUEST', `no such method: ${name}`)
        await admit(ctx, entry.appGrant)
      }
      const value = await entry.run(ctx, params)
      return {
        value,
        text: entry.text !== undefined ? entry.text(value) : JSON.stringify(value, null, 2),
        writes: entry.writes === true,
      }
    },
  }
}
