/**
 * The servers community plugins run, one per opened file
 * (docs/features/community-plugins.md).
 *
 * A tab acquires its file's server and releases it when it closes; tabs on
 * the same file share one, and the last release stops it. Leaving the vault
 * and quitting stop them all. Each runs the manifest's `serve` on a port Holi
 * chose, as its own process group, and is ready when that port on the loopback
 * (127.0.0.1 or ::1) takes a connection. While it is up its origin is registered with the window
 * guard, so its frame can move within it and nowhere else.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import net from 'node:net'
import { pluginServerOrigin } from '@holi/shared'
import {
  CapabilityError,
  defaultProbePid,
  joinOwnedProgram,
  killTree,
  spawnOwnedProgram,
  type ManagedOwnedChild,
  type PidState,
} from '../../../main/plugin-api'
import { splitLines } from './setup'

/** Prezzi's own launcher starts here, above the servers people keep running. */
const FIRST_PORT = 3040
const LOG_LINES = 200

export type ServerState =
  | { state: 'starting'; log: string[] }
  | { state: 'running'; port: number; log: string[] }
  | { state: 'failed'; log: string[]; message: string }
  | { state: 'exited'; log: string[]; message: string }

interface ServeSpec {
  /** The command for `port`, already expanded. */
  argv(port: number): string[]
  cwd: string
  env(port: number): NodeJS.ProcessEnv
  /** The authorization that produced this command and served file. */
  fingerprint?: string
  /** The activation that admitted this start, not whichever owns the vault later. */
  signal?: AbortSignal
  /** Revalidate after reserving a port, and invoke runSpawn synchronously
   *  inside that admission. Its result must not await readiness or cleanup. */
  authorizeSpawn?<T>(runSpawn: () => T): Promise<T>
}

export interface SupervisorDeps {
  /** Every change of a server's state, by its key. */
  onState(key: string, state: ServerState): void
  /** Confine frames on `origin` (`PluginCtx.frameOrigin`); returns the undo. */
  frameOrigin(origin: string, key?: string): () => void
  readyTimeoutMs?: number
  /** How long a stopped server has before SIGKILL. */
  graceMs?: number
  probePid?: (pid: number) => PidState
  firstPort?: number
}

interface ServerLease {
  port: number
  release(): Promise<void>
  isCurrentAndRunning(): boolean
}

interface ServerAdmission {
  ready: Promise<ServerLease>
}

type Readmit = (
  resume: (spec: ServeSpec) => ServerAdmission,
  signal: AbortSignal,
) => Promise<ServerLease>

export interface Supervisor {
  /** The server for `key`, started with `spec` if none is up; resolves when it
   * is ready. Each call is one reference. If an old row is draining, readmit
   * under the caller's authorization with a fresh spec; never await `ready`
   * inside that admission. Without readmission the caller must acquire anew. */
  acquire(key: string, spec: ServeSpec, readmit?: Readmit): Promise<ServerLease>
  /** Drop one reference; the last stops the server. */
  release(key: string): Promise<void>
  /** Stop every server whose key `which` accepts (all, without it),
   *  whoever holds it. */
  stopAll(which?: (key: string) => boolean): Promise<void>
  /** Permanently close this activation and stop every server it owns. */
  dispose(): Promise<void>
  state(key: string): ServerState | null
}

interface Server {
  fingerprint: string | undefined
  refs: number
  port: number
  child: ManagedOwnedChild | null
  log: string[]
  state: ServerState
  ready: Promise<{ port: number }>
  exited: Promise<void>
  ending: boolean
  wake(): void
  unframe: () => void
  /** Set once it is stopped: a start still in flight gives up. */
  stopped: boolean
  stopping: Promise<void> | null
}

function canConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/** Reserve each candidate before probing so a slow pick doesn't block other servers. */
async function reserveFreePort(reserved: Set<number>, from = FIRST_PORT): Promise<number> {
  for (let port = from; port < from + 500; port++) {
    if (reserved.has(port)) continue
    reserved.add(port)
    let picked = false
    try {
      if ((await canConnect(port, '127.0.0.1')) || (await canConnect(port, '::1'))) continue
      picked = await canListen(port)
      if (picked) return port
    } finally {
      if (!picked) reserved.delete(port)
    }
  }
  throw new Error(`no free port between ${from} and ${from + 499}`)
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const servers = new Map<string, Server>()
  const instances = new Map<Server, string>()
  const queued = new Map<AbortController, { key: string; server: Server }>()
  const drains = new Map<(key: string) => boolean, CapabilityError>()
  let disposed = false
  let disposal: Promise<void> | null = null
  const readyTimeout = deps.readyTimeoutMs ?? 60_000
  const grace = deps.graceMs ?? 2_000
  const probe = deps.probePid ?? defaultProbePid
  const platform = process.platform

  const set = (key: string, server: Server, state: ServerState) => {
    server.state = state
    deps.onState(key, state)
  }

  /** Signal the server's group, but only while its pid still leads the group
   *  we started: a reaped pid may already be someone else's (see the agent's
   *  `pty.ts` on why this is never unconditional). So a group whose leader
   *  exited on its own is not signalled, and `serve` must be the server itself,
   *  not a launcher that exits (docs/features/community-plugins.md). */
  const signal = (child: ManagedOwnedChild, sig: 'SIGTERM' | 'SIGKILL') => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (platform === 'win32') {
      child.kill(sig)
      return
    }
    if (child.pid === undefined) return
    if (probe(child.pid) !== 'group-leader') {
      child.kill(sig)
      return
    }
    // Reaped between the probe and here is a no-op.
    killTree(child.pid, sig)
  }

  /** Keep a picked port until its server retires, including during native drain. */
  const reserved = new Set<number>()

  /** Is `server` still the one `key` names? A release, or a release and a
   *  fresh acquire, can replace it while it starts. */
  const current = (key: string, server: Server) => servers.get(key) === server

  const unframe = (server: Server) => {
    server.unframe()
    server.unframe = () => {}
  }

  const retire = (key: string, server: Server) => {
    reserved.delete(server.port)
    instances.delete(server)
    if (current(key, server)) servers.delete(key)
  }

  const stop = (key: string, server: Server, reason?: string): Promise<void> => {
    if (server.stopping !== null) return server.stopping
    server.stopped = true
    unframe(server)
    server.wake()
    if (current(key, server)) {
      if (reason !== undefined && server.state.state === 'running')
        set(key, server, { state: 'exited', log: [...server.log], message: reason })
      // POSIX has no receipt fence; preserve its immediate detach at stop.
      if (platform !== 'win32') servers.delete(key)
    }
    const child = server.child
    server.stopping = (async () => {
      if (child === null) {
        // A port pick in flight observes stopped before it can spawn.
        await server.ready.catch(() => {})
      } else {
        signal(child, 'SIGTERM')
        const timer = setTimeout(() => signal(child, 'SIGKILL'), grace)
        try {
          await server.exited
        } finally {
          clearTimeout(timer)
        }
      }
      retire(key, server)
    })()
    return server.stopping
  }

  // Publish the exact child and its join before releasing spawn admission.
  const launch = (key: string, server: Server, spec: ServeSpec) => {
    const remember = splitLines((line) => {
      server.log.push(line)
      if (server.log.length > LOG_LINES) server.log.splice(0, server.log.length - LOG_LINES)
    })
    const [command, ...args] = spec.argv(server.port)
    const env = spec.env(server.port)
    assertStarting(key, server, spec)
    const child = spawnOwnedProgram(command!, args, {
      cwd: spec.cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.child = child
    const joined = joinOwnedProgram(child, platform)
    const take = (chunk: Buffer) => remember.push(chunk.toString('utf8'))
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const end = () => {
      server.ending = true
      unframe(server)
      server.wake()
    }
    // Helper loss removes frame authority immediately. It does not retire the
    // instance or free its port. Only the join can do that.
    const onHelperEnd = () => {
      end()
      if (!server.stopped && current(key, server) && server.state.state === 'running')
        set(key, server, {
          state: 'exited',
          log: [...server.log],
          message: 'the server helper ended',
        })
    }
    if (platform === 'win32') {
      child.once('exit', onHelperEnd)
      child.once('close', onHelperEnd)
      child.once('error', onHelperEnd)
    }
    const finishOutput = () => {
      child.off('exit', onHelperEnd)
      child.off('close', onHelperEnd)
      child.off('error', onHelperEnd)
      child.stdout?.off('data', take)
      child.stderr?.off('data', take)
      remember.flush()
      end()
    }
    let exitMessage: string | undefined
    server.exited = joined.then(
      ({ code, signal, error, ownership }) => {
        finishOutput()
        exitMessage = error
          ? `could not run ${command}: ${error.message}`
          : ownership === 'not-started'
            ? 'could not start'
            : signal !== null
              ? `stopped by ${signal}`
              : `exited with ${code}`
        if (!server.stopped && current(key, server)) {
          if (server.state.state === 'running' || server.state.state === 'exited')
            set(key, server, { state: 'exited', log: [...server.log], message: exitMessage })
          else
            set(key, server, {
              state: 'failed',
              log: [...server.log],
              message: `the server ${exitMessage} before it was ready`,
            })
        }
        if (server.stopping === null) retire(key, server)
      },
      (error: unknown) => {
        finishOutput()
        if (current(key, server))
          set(key, server, { state: 'failed', log: [...server.log], message: String(error) })
        // Keep the original instance, key, port, and typed failure for all
        // later releases, drains, and replacement attempts.
        throw error
      },
    )
    void server.exited.catch(() => {})
    return () => exitMessage
  }

  const cancelled = (server: Server, spec: ServeSpec) => server.stopped || spec.signal?.aborted
  const assertStarting = (key: string, server: Server, spec: ServeSpec) => {
    if (cancelled(server, spec) || !current(key, server))
      throw new CapabilityError('FORBIDDEN', 'the server was stopped before it started')
  }

  const start = async (key: string, server: Server, spec: ServeSpec): Promise<{ port: number }> => {
    let exitMessage: () => string | undefined
    try {
      server.port = await reserveFreePort(reserved, deps.firstPort)
      // A dead row can retire without waiting for the owner's admission queue.
      assertStarting(key, server, spec)
      const runSpawn = () => launch(key, server, spec)
      exitMessage = spec.authorizeSpawn ? await spec.authorizeSpawn(runSpawn) : runSpawn()
    } catch (error) {
      if (!cancelled(server, spec) && current(key, server))
        set(key, server, { state: 'failed', log: [...server.log], message: String(error) })
      if (server.stopping === null) retire(key, server)
      throw error
    }
    const port = server.port

    const deadline = Date.now() + readyTimeout
    while (!server.ending && !cancelled(server, spec) && Date.now() < deadline) {
      const up = (await canConnect(port, '127.0.0.1')) || (await canConnect(port, '::1'))
      if (cancelled(server, spec) || server.ending) break
      if (up) {
        server.unframe = deps.frameOrigin(pluginServerOrigin(port), key)
        set(key, server, { state: 'running', port, log: [...server.log] })
        return { port }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => server.wake(), 150)
        server.wake = () => {
          clearTimeout(timer)
          server.wake = () => {}
          resolve()
        }
      })
    }
    if (cancelled(server, spec)) {
      await stop(key, server)
      throw new Error('the server was stopped before it was ready')
    }
    if (server.ending) {
      await server.exited
      throw new Error(`the server ${exitMessage() ?? 'exited'} before it was ready`)
    }
    const message = `the server did not answer on port ${port} within ${Math.round(readyTimeout / 1000)} s`
    if (current(key, server)) set(key, server, { state: 'failed', log: [...server.log], message })
    await stop(key, server)
    throw new Error(message)
  }

  const releaseServer = async (key: string, server: Server) => {
    if (server.stopping !== null) return server.stopping
    if (!current(key, server)) return
    server.refs--
    if (server.refs <= 0 || server.ending) await stop(key, server)
  }

  const lease = (key: string, server: Server) =>
    server.ready.then(({ port }) => {
      let released: Promise<void> | undefined
      return {
        port,
        release: () => {
          // Keep the old instance's admission revocable even after EMPTY,
          // while its retry is waiting to re-enter the owner's queue.
          revokeQueued((waiting) => waiting.server === server, new Error('the server was released'))
          return (released ??= releaseServer(key, server))
        },
        isCurrentAndRunning: () =>
          current(key, server) &&
          !server.stopped &&
          !server.ending &&
          server.state.state === 'running',
      }
    })

  const revokeQueued = (
    which: (waiting: { key: string; server: Server }) => boolean,
    reason: Error,
  ) => {
    for (const [abort, waiting] of queued) if (which(waiting)) abort.abort(reason)
  }

  const stopAll = async (which: (key: string) => boolean, reason: string) => {
    const error = new CapabilityError('FORBIDDEN', reason)
    // Each sweep fences only its own keys and only until its rows have joined.
    const matches = (key: string) => which(key)
    if (platform === 'win32') drains.set(matches, error)
    revokeQueued(({ key }) => matches(key), error)
    try {
      const results = await Promise.allSettled(
        [...instances]
          .filter(([, key]) => matches(key))
          .map(([server, key]) => stop(key, server, reason)),
      )
      // One failed owner cannot let another instance outlive its attachment.
      for (const result of results) if (result.status === 'rejected') throw result.reason
    } finally {
      drains.delete(matches)
    }
  }

  const afterDrain = (key: string, old: Server, readmit?: Readmit): Promise<ServerLease> => {
    const abort = new AbortController()
    queued.set(abort, { key, server: old })
    return new Promise<ServerLease>((resolve, reject) => {
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
      void stop(key, old)
        .then(() => {
          abort.signal.throwIfAborted()
          if (!readmit) throw new Error('the old server stopped; acquire again')
          return readmit((spec) => {
            abort.signal.throwIfAborted()
            // Replace the queued admission with the new row in the same turn.
            queued.delete(abort)
            return admit(key, spec, readmit)
          }, abort.signal)
        })
        .then(resolve, reject)
    }).finally(() => queued.delete(abort))
  }

  const admit = (key: string, spec: ServeSpec, readmit?: Readmit): ServerAdmission => {
    if (disposed) return { ready: Promise.reject(new Error('the supervisor is disposed')) }
    for (const [matches, error] of drains) if (matches(key)) return { ready: Promise.reject(error) }
    const existing = servers.get(key)
    if (existing !== undefined) {
      if (existing.stopped || existing.ending) return { ready: afterDrain(key, existing, readmit) }
      // A fresh authorization for this key cannot take a reference to a
      // server started for a different grant, even if it is still starting.
      if (existing.fingerprint !== spec.fingerprint)
        return {
          ready: Promise.reject(
            new CapabilityError('FORBIDDEN', 'community server authorization changed'),
          ),
        }
      existing.refs++
      return { ready: lease(key, existing) }
    }
    const server: Server = {
      fingerprint: spec.fingerprint,
      refs: 1,
      port: 0,
      child: null,
      log: [],
      state: { state: 'starting', log: [] },
      ready: Promise.resolve({ port: 0 }),
      exited: Promise.resolve(),
      ending: false,
      wake: () => {},
      unframe: () => {},
      stopped: false,
      stopping: null,
    }
    instances.set(server, key)
    servers.set(key, server)
    deps.onState(key, server.state)
    server.ready = start(key, server, spec)
    // A failure is reported through `onState`; whoever awaits sees it too.
    void server.ready.catch(() => {})
    return { ready: lease(key, server) }
  }

  return {
    acquire: (key, spec, readmit) => admit(key, spec, readmit).ready,
    async release(key) {
      revokeQueued((waiting) => waiting.key === key, new Error('the server was released'))
      const server = servers.get(key)
      if (server !== undefined) await releaseServer(key, server)
    },
    stopAll: (which = () => true) =>
      stopAll(which, 'server stopped because its installation changed'),
    dispose() {
      if (disposal !== null) return disposal
      // Close synchronously, before yielding to stop() or its child-exit waits.
      disposed = true
      disposal = stopAll(() => true, 'server stopped because its vault closed')
      return disposal
    },
    state: (key) => servers.get(key)?.state ?? null,
  }
}
