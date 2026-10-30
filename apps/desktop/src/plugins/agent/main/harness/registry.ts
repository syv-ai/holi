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
    unattended: `${h.label} runs only in a terminal you watch. Holis, automations, a document's Ask AI and Create vault app need Claude Code, Codex or Pi as this machine's default agent.`,
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
 * A built-in provider reading its preset as it runs: the name, the arguments
 * before its own and the environment a person set. Which program it runs is
 * its own `resolveBin`, given `presetBin`. Its jobs keep their own arguments:
 * those are its sandbox.
 * @public exported for its test
 */
export function withPreset<P extends AgentProvider>(base: P, current: () => Harness): P {
  const preset = presetOf(base.id)
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
      if (command === null) return null
      const h = current()
      return {
        bin: command.bin,
        args: [...h.command.args, ...command.args],
        env: { ...command.env, ...h.env },
      }
    },
  }
}

/** Which program a built-in runs: its own lookup while the preset names its
 *  usual program (which honours `HOLI_<AGENT>_BIN`), else the one named. */
export const presetBin =
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

export interface HarnessRegistry {
  /** Every agent, the built-in ones first. */
  providers(): readonly AgentProvider[]
  /** A harness as it is now, presets included. */
  get(id: string): Harness | undefined
  list(): readonly HarnessView[]
  /** Read the file again: a hand edit, or another window's. */
  reload(): Promise<void>
  /** Write one harness. `create` refuses an id in use; otherwise the id must
   *  be one. Throws with what to do. */
  save(h: Harness, create: boolean): Promise<void>
  /** Remove a harness a person added, or put a preset back. */
  remove(id: string): Promise<void>
}

export interface HarnessRegistryDeps {
  store: Pick<JsonFileStore<HarnessFile>, 'read' | 'update'>
  /** Each built-in provider, given its preset as it is now. */
  builtIns: Record<HarnessIntegration, (current: () => Harness) => AgentProvider>
  /** A harness a person added, as a provider. */
  custom?: (h: Harness) => AgentProvider
}

const same = (a: Harness, b: Harness): boolean => JSON.stringify(a) === JSON.stringify(b)

export async function createHarnessRegistry(deps: HarnessRegistryDeps): Promise<HarnessRegistry> {
  const custom = deps.custom ?? ((h: Harness) => harnessProvider(h))
  let file: HarnessFile = { version: 1, harnesses: [] }
  let added: AgentProvider[] = []
  const presetNow = (id: HarnessIntegration): Harness =>
    file.harnesses.find((h) => h.id === id && h.integration === id) ?? presetOf(id)!
  const builtIns = INTEGRATIONS.map((id) => deps.builtIns[id](() => presetNow(id)))
  const apply = (next: HarnessFile): void => {
    file = next
    added = next.harnesses.filter((h) => h.integration === undefined).map(custom)
  }
  apply(await deps.store.read())

  const get = (id: string): Harness | undefined =>
    INTEGRATIONS.includes(id as HarnessIntegration)
      ? presetNow(id as HarnessIntegration)
      : file.harnesses.find((h) => h.id === id)

  return {
    providers: () => [...builtIns, ...added],
    get,
    list: () => [
      ...PRESETS.map((p) => {
        const harness = presetNow(p.integration!)
        return { harness, builtIn: true, edited: !same(harness, p) }
      }),
      ...file.harnesses
        .filter((h) => h.integration === undefined)
        .map((harness) => ({ harness, builtIn: false, edited: false })),
    ],
    async reload() {
      apply(await deps.store.read())
    },
    async save(h, create) {
      const exists = get(h.id) !== undefined
      if (create && exists) throw new Error(`An agent with the id ${h.id} exists. Choose another.`)
      if (!create && !exists) throw new Error(`There is no agent ${h.id} to change.`)
      const preset = presetOf(h.id)
      apply(
        await deps.store.update((current) => {
          const rest = current.harnesses.filter((x) => x.id !== h.id)
          // A preset put back as Holi has it is no entry at all.
          const keep = preset === undefined || !same(h, preset)
          const at = current.harnesses.findIndex((x) => x.id === h.id)
          const harnesses = keep
            ? at === -1
              ? [...rest, h]
              : current.harnesses.map((x) => (x.id === h.id ? h : x))
            : rest
          return { version: 1, harnesses }
        }),
      )
    },
    async remove(id) {
      if (get(id) === undefined) throw new Error(`There is no agent ${id}.`)
      apply(
        await deps.store.update((current) => ({
          version: 1,
          harnesses: current.harnesses.filter((h) => h.id !== id),
        })),
      )
    },
  }
}
