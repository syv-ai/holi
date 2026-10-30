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
import { spawn } from 'node:child_process'
import {
  cap,
  CapabilityError,
  noParams,
  paramsObject,
  stringParam,
} from '../../../../main/plugin-api'
import { buildAgentEnv } from '../claude/cli'
import { hasBackground, hasJobs } from '../provider'
import { readHarness, type Harness } from './record'
import type { HarnessRegistry } from './registry'

/** How long Test lets the program run. */
const TEST_TIMEOUT_MS = 5_000
/** How long a stopped test has to end before it is killed. */
const TEST_KILL_GRACE_MS = 1_000
/** The most output Test reads before it stops the program. */
const TEST_READ_MAX = 256 * 1024
/** The most of its output Test shows. */
const TEST_OUTPUT_MAX = 4_000

/** One harness, as Settings lists it. */
interface HarnessSummary {
  harness: Harness
  builtIn: boolean
  edited: boolean
  /** The program, found on this machine as its sessions find it; null when
   *  it is not. */
  path: string | null
  /** Why Holis, automations and Create vault app cannot run on it, or null
   *  when they can. */
  unattended: string | null
}

/** This machine's agents, and what reading their file left out. */
export interface HarnessListing {
  agents: HarnessSummary[]
  /** Where the file is. */
  file: string
  /** Entries in it that did not read as an agent. */
  ignored: number
  /** Why the file could not be read at all, or null when it was. */
  unreadable: string | null
}

export type HarnessTestResult =
  { ok: true; output: string } | { ok: false; message: string; output: string }

interface TestRun {
  code: number | null
  output: string
  /** Still running at the time limit, and stopped. */
  timedOut: boolean
  /** It printed more than Test reads, and was stopped. */
  overLimit: boolean
}

export interface HarnessCapabilitiesDeps {
  registry: HarnessRegistry
  /** The file the harnesses are kept in, to name in Settings. */
  file: string
  /** The open vault's clone: where Test runs, as a session would. */
  root(): string | null
  /** The harnesses changed: the renderer asks for the agents again. */
  changed(): void
  /** What runs the test. */
  run?: (
    bin: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ) => Promise<TestRun>
}

/**
 * Run a test in a process group of its own, so that stopping it (at the time
 * limit, or once it printed too much) stops whatever it started too: TERM to
 * the group, then KILL after a grace.
 */
function defaultRun(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<TestRun> {
  return new Promise((resolve) => {
    // A test reads nothing: its input is closed from the start.
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let read = 0
    let stopped: 'timeout' | 'over' | null = null
    let kill: NodeJS.Timeout | null = null
    const signal = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, sig)
      } catch {
        // The group is gone already.
      }
    }
    const stop = (why: 'timeout' | 'over'): void => {
      if (stopped !== null) return
      stopped = why
      signal('SIGTERM')
      kill = setTimeout(() => signal('SIGKILL'), TEST_KILL_GRACE_MS)
    }
    const take = (chunk: Buffer): void => {
      if (read >= TEST_READ_MAX) return
      chunks.push(chunk)
      read += chunk.length
      if (read >= TEST_READ_MAX) stop('over')
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs)
    const done = (run: TestRun): void => {
      clearTimeout(timer)
      if (kill !== null) clearTimeout(kill)
      resolve(run)
    }
    child.on('error', (err) =>
      done({ code: null, output: err.message, timedOut: false, overLimit: false }),
    )
    child.on('close', (code) =>
      done({
        code,
        output: Buffer.concat(chunks).toString('utf8'),
        timedOut: stopped === 'timeout',
        overLimit: stopped === 'over',
      }),
    )
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
      run: async (): Promise<HarnessListing> => {
        await deps.registry.reload()
        const providers = deps.registry.providers()
        const agents = deps.registry.list().map((v) => {
          const p = providers.find((x) => x.id === v.harness.id)
          return {
            ...v,
            path: deps.registry.resolve(v.harness.id),
            unattended:
              p === undefined || hasBackground(p) || hasJobs(p)
                ? null
                : (p.unattended ?? `${p.label} cannot run a job with nobody watching.`),
          }
        })
        return { agents, file: deps.file, ...deps.registry.status() }
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

    /** Start the file over when it could not be read, a copy of it kept
     *  beside it as `.bad`. */
    'agent.harnessReset': cap({
      doors: ['ui'],
      params: noParams,
      run: async (): Promise<{ ok: true }> => {
        await deps.registry.reset().catch(failed)
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
        const bin = deps.registry.resolve(id)
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
          return {
            ok: false,
            message: 'It was still running after 5 seconds, so Holi stopped it.',
            output,
          }
        }
        if (res.overLimit) {
          return {
            ok: false,
            message: `It printed more than ${TEST_READ_MAX / 1024} KB, so Holi stopped it.`,
            output,
          }
        }
        return res.code === 0
          ? { ok: true, output }
          : { ok: false, message: `It exited with ${res.code ?? 'a signal'}.`, output }
      },
    }),
  }
}
