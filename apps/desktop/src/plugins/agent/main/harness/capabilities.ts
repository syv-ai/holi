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
import {
  cap,
  joinOwnedProgram,
  CapabilityError,
  noParams,
  paramsObject,
  spawnOwnedProgram,
  ownedProcessDrain,
  posixLaunchNonAdmission,
  stringParam,
} from '../../../../main/plugin-api'
import { buildAgentEnv } from '../claude/cli'
import { bounded } from '../host/bounded'
import { AgentProbeCleanupError, type AgentProbeOwner } from '../probe-owner'
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
  error?: string
  /** Still running at the time limit, and stopped. */
  timedOut: boolean
  /** It printed more than Test reads, and was stopped. */
  overLimit: boolean
  cancelled?: boolean
}

export interface HarnessCapabilitiesDeps {
  registry: HarnessRegistry
  probes: AgentProbeOwner
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
    opts: {
      cwd: string
      env: Record<string, string>
      timeoutMs: number
      signal?: AbortSignal
      graceMs?: number
    },
  ) => Promise<TestRun>
}

/**
 * Run a test in a process group of its own, so that stopping it (at the time
 * limit, or once it printed too much) stops whatever it started too: TERM to
 * the group, then KILL after a grace.
 */
async function defaultRun(
  bin: string,
  args: string[],
  opts: {
    cwd: string
    env: Record<string, string>
    timeoutMs: number
    signal?: AbortSignal
    graceMs?: number
  },
): Promise<TestRun> {
  if (opts.signal?.aborted) throw new Error('Harness test cancelled.')
  const platform = process.platform
  let child
  try {
    child = spawnOwnedProgram(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      posixGroupLease: platform !== 'win32',
      graceMs: opts.graceMs ?? TEST_KILL_GRACE_MS,
      signal: opts.signal,
    })
  } catch (error) {
    const nonAdmission = posixLaunchNonAdmission(error)
    const cleanup = nonAdmission?.cleanup ?? (error as { cleanup?: Promise<unknown> })?.cleanup
    const authority = cleanup
      ? {
          drain: async () => {
            await cleanup
          },
        }
      : undefined
    try {
      await cleanup
    } catch (failure) {
      throw new AgentProbeCleanupError(failure, authority)
    }
    if (nonAdmission) throw error
    throw new AgentProbeCleanupError(error, authority)
  }
  const authority = child[ownedProcessDrain]
  if (platform !== 'win32' && !authority)
    throw new AgentProbeCleanupError(new Error('The test process has no cleanup authority.'))
  const joined = joinOwnedProgram(child, platform)
  const chunks: Buffer[] = []
  let read = 0
  let stopped: 'timeout' | 'over' | 'cancelled' | null = null
  let exited = false
  let timer: NodeJS.Timeout | undefined
  let kill: NodeJS.Timeout | undefined
  let drainStarted = false
  let resolveDrain!: () => void
  let rejectDrain!: (error: unknown) => void
  const drained = new Promise<void>((resolve, reject) => {
    resolveDrain = resolve
    rejectDrain = reject
  })
  void drained.catch(() => {})
  const cleanupFailure = (error: unknown): void => {
    // Keep observing the original authority even when the immediate Windows
    // kill request throws: a later receipt may still carry the process lease.
    const cleanupAuthority =
      platform === 'win32' ? { drain: () => joined.then(() => {}) } : authority
    rejectDrain(
      error instanceof AgentProbeCleanupError
        ? error
        : new AgentProbeCleanupError(error, cleanupAuthority),
    )
  }
  const requestDrain = (): void => {
    if (drainStarted) return
    drainStarted = true
    try {
      if (authority) void authority.drain().then(resolveDrain, cleanupFailure)
      else void joined.then(() => resolveDrain(), rejectDrain)
    } catch (error) {
      cleanupFailure(error)
    }
  }
  const signal = (sig: NodeJS.Signals): void => {
    try {
      child.kill(sig)
    } catch (error) {
      cleanupFailure(error)
    }
  }
  const stop = (why: 'timeout' | 'over' | 'cancelled'): void => {
    if (stopped !== null || exited) return
    stopped = why
    clearTimeout(timer)
    requestDrain()
    // The POSIX authority owns signalling and its grace period, including pre-GO cancellation.
    if (platform === 'win32') {
      signal('SIGTERM')
      kill = setTimeout(() => signal('SIGKILL'), opts.graceMs ?? TEST_KILL_GRACE_MS)
    }
  }
  const take = (chunk: Buffer): void => {
    const remaining = TEST_READ_MAX - read
    if (remaining <= 0) return
    chunks.push(chunk.subarray(0, remaining))
    read += Math.min(chunk.length, remaining)
    if (read >= TEST_READ_MAX) stop('over')
  }
  const onAbort = (): void => stop('cancelled')
  const onExit = (): void => {
    exited = true
    clearTimeout(timer)
    requestDrain()
  }
  const onError = (): void => {
    clearTimeout(timer)
    requestDrain()
  }
  child.stdout?.on('data', take)
  child.stderr?.on('data', take)
  child.once('exit', onExit)
  child.once('error', onError)
  timer = setTimeout(() => stop('timeout'), opts.timeoutMs)
  if (opts.signal?.aborted) stop('cancelled')
  else opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // A physical failure settles independently of close. Once proof succeeds,
    // transport/output must settle within a bound rather than retaining the activation forever.
    const result = await Promise.race([
      joined.then(async (result) => {
        requestDrain()
        await drained
        return result
      }),
      drained
        .then(() => bounded(joined, 'Harness test output'))
        .catch((error: unknown) => {
          if (platform === 'win32' || error instanceof AgentProbeCleanupError) throw error
          throw new AgentProbeCleanupError(error, authority)
        }),
    ])
    return {
      code: result.code,
      output: Buffer.concat(chunks).toString('utf8'),
      ...(result.error === null ? {} : { error: result.error.message }),
      timedOut: stopped === 'timeout',
      overLimit: stopped === 'over',
      cancelled: stopped === 'cancelled',
    }
  } finally {
    clearTimeout(timer)
    clearTimeout(kill)
    child.stdout?.off('data', take)
    child.stderr?.off('data', take)
    child.off('exit', onExit)
    child.off('error', onError)
    opts.signal?.removeEventListener('abort', onAbort)
  }
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
            // Pi runs unattended work through its RPC supervisor, outside
            // its capabilities (`host/capabilities.ts`, `deps.pi`).
            unattended:
              p === undefined || hasBackground(p) || hasJobs(p) || p.id === 'pi'
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
      run: (_ctx, { id }) =>
        deps.probes.run(async (signal): Promise<HarnessTestResult> => {
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
            signal,
          })
          const output = res.output.slice(0, TEST_OUTPUT_MAX)
          if (res.cancelled) return { ok: false, message: 'Harness test cancelled.', output }
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
          if (res.error !== undefined) return { ok: false, message: res.error, output }
          return res.code === 0
            ? { ok: true, output }
            : { ok: false, message: `It exited with ${res.code ?? 'a signal'}.`, output }
        }),
    }),
  }
}
