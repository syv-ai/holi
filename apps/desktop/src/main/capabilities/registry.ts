/**
 * What a vault app, and the agent, can ask Holi for: one registry, every door.
 *
 * **The app door** is the `window.holi` bridge: `postMessage` from the
 * sandboxed frame to `AppFrame`, which forwards into `apps.bridge`. **The CLI
 * door** is `holi <group> <verb>` over the bridge's loopback port (`bridge/`). Each
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
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { VaultSnapshot } from '@holi/shared'
import { CapabilityError } from './error'
import type { CoreServices } from './services'

export type Door = 'app' | 'cli'

export interface CapabilityContext {
  remote: string
  /** The vault clone's root on this machine. */
  root: string
  /** The calling app's bundle at the app door; null at the CLI door. */
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
}

export interface Capability<P = unknown, R = unknown> {
  doors: readonly Door[]
  cli?: CliSpec
  /** Changes the vault, so the open vault's cache is refreshed after it. */
  writes?: true
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

/** An entry, with its params' and result's types inferred. */
export function cap<P, R>(c: Capability<P, R>): Capability<P, R> {
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
   *  no other caller may already own. Throws otherwise. Returns the undo. */
  register(namespaces: readonly string[], table: CapabilityTable): () => void
  has(name: string): boolean
  /** Every entry open at the CLI door, as a command, by name. */
  commands(): CliCommand[]
  /**
   * Run one capability through one door. An unknown name, or one that does
   * not open to this door, is refused as "no such method", which is what it is
   * from where the caller stands.
   */
  run(
    name: string,
    door: Door,
    ctx: CapabilityContext,
    rawParams: unknown,
  ): Promise<CapabilityResult>
}

/** A name's namespace, or null for a name that is not `<namespace>.<verb>`. */
const namespaceOf = (name: string): string | null => {
  const dot = name.indexOf('.')
  return dot <= 0 || dot === name.length - 1 ? null : name.slice(0, dot)
}

export function createCapabilityRegistry(): CapabilityRegistry {
  const owners = new Map<string, CapabilityTable>()
  const entries = new Map<string, AnyCapability>()

  return {
    register(namespaces, table) {
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
      for (const [name, entry] of Object.entries(table)) entries.set(name, entry)
      return () => {
        for (const ns of namespaces) if (owners.get(ns) === table) owners.delete(ns)
        for (const [name, entry] of Object.entries(table)) {
          if (entries.get(name) === entry) entries.delete(name)
        }
      }
    },

    has: (name) => entries.has(name),

    commands: () =>
      [...entries]
        .flatMap(([name, entry]) => (entry.cli === undefined ? [] : [{ name, cli: entry.cli }]))
        .sort((a, b) => a.name.localeCompare(b.name)),

    async run(name, door, ctx, rawParams) {
      const entry = entries.get(name)
      if (entry === undefined || !entry.doors.includes(door)) {
        throw new CapabilityError('BAD_REQUEST', `no such method: ${name}`)
      }
      const value = await entry.run(ctx, entry.params(rawParams))
      return {
        value,
        text: entry.text !== undefined ? entry.text(value) : JSON.stringify(value, null, 2),
        writes: entry.writes === true,
      }
    },
  }
}
