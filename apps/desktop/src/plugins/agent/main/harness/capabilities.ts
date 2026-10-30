/**
 * The harnesses in Settings (docs/features/agent-sessions.md, Harnesses):
 * listed, saved, removed and tested, at the UI door alone.
 *
 * **Never the CLI door, nor an app's.** A harness is a program Holi runs with
 * the person's rights: an agent session that could add one would be running
 * whatever it liked, outside every permission prompt. Only a person, in
 * Settings, edits them.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { execFile } from 'node:child_process'
import {
  cap,
  CapabilityError,
  noParams,
  paramsObject,
  stringParam,
} from '../../../../main/plugin-api'
import { buildAgentEnv } from '../claude/cli'
import { readHarness, resolveHarnessBin, type Harness } from './record'
import type { HarnessRegistry } from './registry'

/** How long Test lets the program run. */
const TEST_TIMEOUT_MS = 5_000
/** The most of its output Test shows. */
const TEST_OUTPUT_MAX = 4_000

/** One harness, as Settings lists it. */
export interface HarnessSummary {
  harness: Harness
  builtIn: boolean
  edited: boolean
  /** The program, found on this machine; null when it is not. */
  path: string | null
}

export type HarnessTestResult =
  { ok: true; output: string } | { ok: false; message: string; output: string }

export interface HarnessCapabilitiesDeps {
  registry: HarnessRegistry
  /** The open vault's clone: where Test runs, as a session would. */
  root(): string | null
  /** The harnesses changed: the renderer asks for the agents again. */
  changed(): void
  /** What runs the test. */
  run?: (
    bin: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ) => Promise<{ code: number | null; output: string; timedOut: boolean }>
}

function defaultRun(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        const output = `${String(stdout)}${String(stderr)}`
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null
        resolve({
          code: e === null ? 0 : typeof e.code === 'number' ? e.code : null,
          output: e !== null && output === '' ? e.message : output,
          timedOut: e?.killed === true,
        })
      },
    )
    // A test reads nothing: its input is closed at once.
    child.stdin?.end()
  })
}

const harnessParams = (raw: unknown): { harness: Harness; create: boolean } => {
  const p = paramsObject(raw)
  const read = readHarness(p['harness'])
  if (!read.ok) throw new CapabilityError('BAD_REQUEST', read.problems.join(' '))
  return { harness: read.harness, create: p['create'] === true }
}

const idParams = (raw: unknown): { id: string } => ({ id: stringParam(paramsObject(raw), 'id') })

export const harnessCapabilities = (deps: HarnessCapabilitiesDeps) => {
  const run = deps.run ?? defaultRun
  const failed = (err: unknown): never => {
    throw new CapabilityError('BAD_REQUEST', err instanceof Error ? err.message : String(err))
  }
  return {
    /** This machine's agents, re-read from their file. */
    'agent.harnesses': cap({
      doors: ['ui'],
      params: noParams,
      run: async (): Promise<HarnessSummary[]> => {
        await deps.registry.reload()
        return deps.registry.list().map((v) => ({
          ...v,
          path: resolveHarnessBin(v.harness.command.bin),
        }))
      },
    }),

    /** Add a harness (`create`), or change one. */
    'agent.harnessSave': cap({
      doors: ['ui'],
      params: harnessParams,
      run: async (_ctx, { harness, create }): Promise<{ ok: true }> => {
        await deps.registry.save(harness, create).catch(failed)
        deps.changed()
        return { ok: true }
      },
    }),

    /** Remove a harness a person added, or put a preset back as Holi has it. */
    'agent.harnessRemove': cap({
      doors: ['ui'],
      params: idParams,
      run: async (_ctx, { id }): Promise<{ ok: true }> => {
        await deps.registry.remove(id).catch(failed)
        deps.changed()
        return { ok: true }
      },
    }),

    /** Run a harness's test arguments in the vault, for five seconds at
     *  most, and say what it printed. */
    'agent.harnessTest': cap({
      doors: ['ui'],
      params: idParams,
      run: async (_ctx, { id }): Promise<HarnessTestResult> => {
        const h = deps.registry.get(id)
        if (h === undefined) return { ok: false, message: `There is no agent ${id}.`, output: '' }
        const bin = resolveHarnessBin(h.command.bin)
        if (bin === null) {
          const provider = deps.registry.providers().find((p) => p.id === id)
          return { ok: false, message: provider?.notInstalled ?? 'Not found.', output: '' }
        }
        const root = deps.root()
        if (root === null) return { ok: false, message: 'Open a vault first.', output: '' }
        const env = { ...buildAgentEnv(process.env), ...h.env }
        const res = await run(bin, h.test ?? ['--version'], {
          cwd: root,
          env,
          timeoutMs: TEST_TIMEOUT_MS,
        })
        const output = res.output.slice(0, TEST_OUTPUT_MAX)
        if (res.timedOut) {
          return { ok: false, message: 'It was still running after 5 seconds.', output }
        }
        return res.code === 0
          ? { ok: true, output }
          : { ok: false, message: `It exited with ${res.code ?? 'a signal'}.`, output }
      },
    }),
  }
}
