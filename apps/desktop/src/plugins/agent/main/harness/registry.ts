/**
 * This machine's agents, as one re-readable registry
 * (docs/features/agent-sessions.md, Harnesses): the three built-in providers,
 * each kept once and reading its preset as it runs, then a basic terminal
 * agent for each harness a person added.
 *
 * The sessions, jobs and capabilities read `providers()` per call, so an edit
 * in Settings reaches the next session without restarting the agent.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { JsonFileStore } from '../../../../main/plugin-api'
import { buildAgentEnv } from '../claude/cli'
import { SESSION_ENV } from '../codex'
import type { AgentProvider, TerminalOpts } from '../provider'
import {
  harnessArgs,
  harnessRefusal,
  INTEGRATIONS,
  isIntegration,
  notFound,
  PRESETS,
  presetOf,
  resolveHarnessBin,
  type Harness,
  type HarnessFile,
  type HarnessIntegration,
  type HarnessOpts,
} from './record'

const optsOf = (opts: TerminalOpts): HarnessOpts => ({
  ...(opts.prompt === undefined ? {} : { prompt: opts.prompt }),
  ...(opts.resume === undefined ? {} : { resume: opts.resume }),
})

/**
 * A harness a person added, as a provider: the core alone. Its CLI runs in a
 * PTY of its own with the vault as cwd, named to its hooks by
 * `HOLI_AGENT_SESSION`; it runs nothing unattended.
 * @public exported for its test
 */
export function harnessProvider(
  h: Harness,
  resolve: (bin: string) => string | null = (bin) => resolveHarnessBin(bin),
): AgentProvider {
  return {
    id: h.id,
    label: h.label,
    custom: true,
    notInstalled: notFound(h),
    installed: () => resolve(h.command.bin) !== null,
    // Nothing of the CLI's own is provisioned: its home stays the person's.
    configure: async ({ root }) => ({ dir: root }),
    refuses: (opts) => harnessRefusal(h, optsOf(opts)),
    unattended: `${h.label} runs only in a terminal you watch. Holis, automations and Create vault app need Claude Code, Codex or Pi as this machine's default agent.`,
    terminal(target, opts = {}) {
      const path = resolve(h.command.bin)
      if (path === null) return null
      const env = { ...buildAgentEnv(process.env, { binDir: target.binDir }), ...h.env }
      delete env[SESSION_ENV]
      if (opts.session !== undefined) env[SESSION_ENV] = opts.session
      return { bin: path, args: harnessArgs(h, optsOf(opts)), env }
    },
    capabilities: {},
  }
}

/**
 * A built-in provider reading its preset as it runs: the name, and for its
 * terminals the arguments before its own and the environment a person set.
 * Which program it runs is its own `resolveBin`, given `presetBin`. Its jobs
 * keep their own arguments, which are its sandbox; Codex reads the
 * preset's environment for its jobs itself.
 *
 * Claude Code takes neither arguments nor environment: its sessions are its
 * background supervisor's, which reads nothing of the preset, so a terminal
 * given them (`claude attach`) would differ from the session it shows.
 * @public exported for its test
 */
export function withPreset<P extends AgentProvider>(base: P, current: () => Harness): P {
  const preset = presetOf(base.id)
  const passes = base.id !== 'claude'
  return {
    ...base,
    get label() {
      return current().label
    },
    get notInstalled() {
      const h = current()
      return preset !== undefined && h.command.bin === preset.command.bin
        ? base.notInstalled
        : notFound(h)
    },
    terminal(target, opts) {
      const command = base.terminal(target, opts)
      if (command === null || !passes) return command
      const h = current()
      return {
        bin: command.bin,
        args: [...h.command.args, ...command.args],
        env: {
          ...command.env,
          ...h.env,
          // A fenced Codex run has its own prepared home; the preset's
          // CODEX_HOME was used as the source, not the run's destination.
          ...(base.id === 'codex' && opts?.fence !== undefined
            ? { CODEX_HOME: command.env.CODEX_HOME }
            : {}),
        },
      }
    },
  }
}

/** Which program a built-in runs: its own lookup while the preset names its
 *  usual program (which honours `HOLI_<AGENT>_BIN`), else the one named. */
const presetBin =
  (id: HarnessIntegration, current: () => Harness, own: () => string | null) =>
  (): string | null => {
    const bin = current().command.bin
    return bin === presetOf(id)?.command.bin ? own() : resolveHarnessBin(bin)
  }

interface HarnessView {
  harness: Harness
  builtIn: boolean
  /** A preset changed from Holi's. */
  edited: boolean
}

/** What reading the file left out, for Settings to say. */
interface HarnessFileStatus {
  /** Entries that did not read as a harness. */
  ignored: number
  /** Why the file could not be read at all, or null when it was. */
  unreadable: string | null
}

export interface HarnessRegistry {
  /** Stop receiving shared configuration changes and drain this handle's writes. */
  dispose(): Promise<void>
  /** Observe a change from any activation sharing this owner. */
  subscribe(listener: () => void): () => void
  /** Every agent, the built-in ones first. */
  providers(): readonly AgentProvider[]
  /** A harness as it is now, presets included. */
  get(id: string): Harness | undefined
  /** The program an agent runs, found as its sessions find it (a built-in's
   *  own lookup, `HOLI_<AGENT>_BIN` included). Null when it is not there. */
  resolve(id: string): string | null
  list(): readonly HarnessView[]
  status(): HarnessFileStatus
  /** Read the file again: a hand edit, or another window's. */
  reload(): Promise<void>
  /** Write one harness. `create` refuses an id in use; otherwise the id must
   *  be one. Throws with what to do. */
  save(h: Harness, create: boolean): Promise<void>
  /** Remove a harness a person added, or put a preset back. */
  remove(id: string): Promise<void>
  /** Start the file over, empty, a copy of it kept first. */
  reset(): Promise<void>
}

export interface HarnessRegistryDeps {
  store: Pick<JsonFileStore<HarnessFile>, 'read' | 'update'>
  /** Each built-in provider, given its preset as it is now and the program
   *  it runs (`presetBin`). */
  builtIns: Record<
    HarnessIntegration,
    (current: () => Harness, bin: () => string | null) => AgentProvider
  >
  /** Each built-in's own lookup of its usual program. Absent: `PATH`. */
  bins?: Partial<Record<HarnessIntegration, () => string | null>>
  /** A harness a person added, as a provider. */
  custom?: (h: Harness) => AgentProvider
  /** Keep a copy of the file as it is (`.bad` beside it), before a write
   *  that would lose what Holi could not read in it. */
  keepBad?: () => Promise<void>
}

const same = (a: Harness, b: Harness): boolean => JSON.stringify(a) === JSON.stringify(b)

interface HarnessConfigOwner {
  ready(): Promise<void>
  current(): HarnessFile
  subscribe(listener: () => void): () => void
  reload(): Promise<void>
  save(harness: Harness, create: boolean): Promise<void>
  remove(id: string): Promise<void>
  reset(): Promise<void>
  drain(): Promise<void>
}

const owners = new Map<string, { owner: HarnessConfigOwner; references: number }>()

function createConfigOwner(deps: HarnessRegistryDeps): HarnessConfigOwner {
  const keepBad = deps.keepBad ?? (async () => {})
  let file: HarnessFile = { version: 1, harnesses: [] }
  const listeners = new Set<() => void>()
  let queue: Promise<void> = Promise.resolve()
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = queue.then(operation)
    queue = task.then(
      () => {},
      () => {},
    )
    return task
  }
  const apply = (next: HarnessFile, notify = true): void => {
    file = next
    if (notify) for (const listener of listeners) listener()
  }
  const initial = enqueue(async () => apply(await deps.store.read(), false))
  const write = (change: (current: HarnessFile) => HarnessFile['harnesses']): Promise<void> =>
    enqueue(async () => {
      await initial
      const next = await deps.store.update(async (current) => {
        if (current.unreadable !== undefined) {
          throw new Error(
            `Holi could not read this machine's agents file. ${current.unreadable} It changes nothing in it until you fix the file, or reset it in Settings, General, Agents.`,
          )
        }
        if ((current.ignored ?? 0) > 0) await keepBad()
        return { version: 1, harnesses: change(current) }
      })
      apply(next)
    })
  return {
    ready: () => initial,
    current: () => file,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reload: () =>
      enqueue(async () => {
        await initial
        apply(await deps.store.read())
      }),
    save: (h, create) =>
      write((current) => {
        const exists = current.harnesses.some((item) => item.id === h.id) || isIntegration(h.id)
        if (create && exists)
          throw new Error(`An agent with the id ${h.id} exists. Choose another.`)
        if (!create && !exists) throw new Error(`There is no agent ${h.id} to change.`)
        const preset = presetOf(h.id)
        const rest = current.harnesses.filter((item) => item.id !== h.id)
        if (preset !== undefined && same(h, preset)) return rest
        if (!current.harnesses.some((item) => item.id === h.id)) return [...rest, h]
        return current.harnesses.map((item) => (item.id === h.id ? h : item))
      }),
    remove: (id) =>
      write((current) => {
        if (!isIntegration(id) && !current.harnesses.some((item) => item.id === id)) {
          throw new Error(`There is no agent ${id}.`)
        }
        return current.harnesses.filter((item) => item.id !== id)
      }),
    reset: () =>
      enqueue(async () => {
        await initial
        const next = await deps.store.update(async () => {
          await keepBad()
          return { version: 1, harnesses: [] }
        })
        apply(next)
      }),
    drain: () => queue,
  }
}

export async function acquireHarnessRegistry(
  key: string,
  deps: HarnessRegistryDeps,
): Promise<HarnessRegistry> {
  let entry = owners.get(key)
  if (entry === undefined) {
    entry = { owner: createConfigOwner(deps), references: 0 }
    owners.set(key, entry)
  }
  entry.references += 1
  let registry: HarnessRegistry
  try {
    registry = await createHarnessRegistry(deps, entry.owner)
  } catch (err) {
    entry.references -= 1
    if (entry.references === 0) {
      await entry.owner.drain()
      if (owners.get(key) === entry) owners.delete(key)
    }
    throw err
  }
  let released = false
  return {
    ...registry,
    async dispose() {
      if (released) return
      released = true
      await registry.dispose()
      entry!.references -= 1
      if (entry!.references === 0) {
        await entry!.owner.drain()
        if (owners.get(key) === entry) owners.delete(key)
      }
    },
  }
}

export async function createHarnessRegistry(
  deps: HarnessRegistryDeps,
  owner: HarnessConfigOwner = createConfigOwner(deps),
): Promise<HarnessRegistry> {
  await owner.ready()
  const custom = deps.custom ?? ((h: Harness) => harnessProvider(h))
  let added: AgentProvider[] = []
  const currentFile = (): HarnessFile => owner.current()
  const presetNow = (id: HarnessIntegration): Harness =>
    currentFile().harnesses.find((h) => h.id === id && h.integration === id) ?? presetOf(id)!
  const bins = Object.fromEntries(
    INTEGRATIONS.map((id) => [
      id,
      presetBin(
        id,
        () => presetNow(id),
        deps.bins?.[id] ?? (() => resolveHarnessBin(presetOf(id)!.command.bin)),
      ),
    ]),
  ) as Record<HarnessIntegration, () => string | null>
  const builtIns = INTEGRATIONS.map((id) => deps.builtIns[id](() => presetNow(id), bins[id]))
  const listeners = new Set<() => void>()
  const refresh = (): void => {
    added = currentFile()
      .harnesses.filter((h) => h.integration === undefined)
      .map(custom)
    for (const listener of listeners) listener()
  }
  refresh()
  const unsubscribe = owner.subscribe(refresh)
  let disposed = false
  const get = (id: string): Harness | undefined =>
    isIntegration(id) ? presetNow(id) : currentFile().harnesses.find((h) => h.id === id)

  return {
    async dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      listeners.clear()
      await owner.drain()
    },
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    providers: () => [...builtIns, ...added],
    get,
    resolve: (id) => {
      if (isIntegration(id)) return bins[id]()
      const h = get(id)
      return h === undefined ? null : resolveHarnessBin(h.command.bin)
    },
    list: () => [
      ...PRESETS.map((p) => {
        const harness = presetNow(p.integration!)
        return { harness, builtIn: true, edited: !same(harness, p) }
      }),
      ...currentFile()
        .harnesses.filter((h) => h.integration === undefined)
        .map((harness) => ({ harness, builtIn: false, edited: false })),
    ],
    status: () => ({
      ignored: currentFile().ignored ?? 0,
      unreadable: currentFile().unreadable ?? null,
    }),
    reload: () => owner.reload(),
    save: (h, create) => owner.save(h, create),
    remove: (id) => owner.remove(id),
    reset: () => owner.reset(),
  }
}
