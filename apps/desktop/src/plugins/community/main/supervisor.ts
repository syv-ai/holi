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
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { pluginServerOrigin } from '@holi/shared'
import { defaultProbePid, type PidState } from '../../../main/plugin-api'
import { splitLines } from './setup'

/** Prezzi's own launcher starts here, above the servers people keep running. */
export const FIRST_PORT = 3040
const LOG_LINES = 200

export type ServerState =
  | { state: 'starting'; log: string[] }
  | { state: 'running'; port: number; log: string[] }
  | { state: 'failed'; log: string[]; message: string }
  | { state: 'exited'; log: string[]; message: string }

export interface ServeSpec {
  /** The command for `port`, already expanded. */
  argv(port: number): string[]
  cwd: string
  env(port: number): NodeJS.ProcessEnv
}

export interface SupervisorDeps {
  /** Every change of a server's state, by its key. */
  onState(key: string, state: ServerState): void
  /** Confine frames on `origin` (`AppContext.frameOrigin`); returns the undo. */
  frameOrigin(origin: string): () => void
  readyTimeoutMs?: number
  /** How long a stopped server has before SIGKILL. */
  graceMs?: number
  probePid?: (pid: number) => PidState
  firstPort?: number
}

export interface Supervisor {
  /** The server for `key`, started with `spec` if none is up; resolves when it
   *  is ready. Each call is one reference. */
  acquire(key: string, spec: ServeSpec): Promise<{ port: number }>
  /** Drop one reference; the last stops the server. */
  release(key: string): Promise<void>
  /** Stop every server whose key `which` accepts (all, without it),
   *  whoever holds it. */
  stopAll(which?: (key: string) => boolean): Promise<void>
  state(key: string): ServerState | null
}

interface Server {
  refs: number
  port: number
  child: ChildProcess | null
  log: string[]
  state: ServerState
  ready: Promise<{ port: number }>
  exited: Promise<void>
  unframe: () => void
  /** Set once it is stopped: a start still in flight gives up. */
  stopped: boolean
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

/** A port nobody is on, from `from` up, skipping `taken`. */
export async function findFreePort(taken: ReadonlySet<number>, from = FIRST_PORT): Promise<number> {
  for (let port = from; port < from + 500; port++) {
    if (taken.has(port)) continue
    if ((await canConnect(port, '127.0.0.1')) || (await canConnect(port, '::1'))) continue
    if (await canListen(port)) return port
  }
  throw new Error(`no free port between ${from} and ${from + 499}`)
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const servers = new Map<string, Server>()
  const readyTimeout = deps.readyTimeoutMs ?? 60_000
  const grace = deps.graceMs ?? 2_000
  const probe = deps.probePid ?? defaultProbePid

  const set = (key: string, server: Server, state: ServerState) => {
    server.state = state
    deps.onState(key, state)
  }

  /** Signal the server's group, but only while its pid still leads the group
   *  we started: a reaped pid may already be someone else's (see the agent's
   *  `pty.ts` on why this is never unconditional). So a group whose leader
   *  exited on its own is not signalled, and `serve` must be the server itself,
   *  not a launcher that exits (docs/features/community-plugins.md). */
  const signal = (child: ChildProcess, sig: 'SIGTERM' | 'SIGKILL') => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    if (probe(child.pid) !== 'group-leader') {
      child.kill(sig)
      return
    }
    try {
      process.kill(-child.pid, sig)
    } catch {
      // Reaped between the probe and here.
    }
  }

  /** Ports held by a server from the moment one is picked until it stops,
   *  so two starting at once cannot both pick the same free port. */
  const reserved = new Set<number>()
  let picking: Promise<unknown> = Promise.resolve()
  const pickPort = (): Promise<number> => {
    const next = picking.then(async () => {
      const port = await findFreePort(reserved, deps.firstPort)
      reserved.add(port)
      return port
    })
    picking = next.catch(() => undefined)
    return next
  }

  /** Is `server` still the one `key` names? A release, or a release and a
   *  fresh acquire, can replace it while it starts. */
  const current = (key: string, server: Server) => servers.get(key) === server

  const stop = async (key: string, server: Server) => {
    if (current(key, server)) servers.delete(key)
    server.stopped = true
    server.unframe()
    server.unframe = () => {}
    const child = server.child
    if (child === null) return
    signal(child, 'SIGTERM')
    const timer = setTimeout(() => signal(child, 'SIGKILL'), grace)
    await server.exited
    clearTimeout(timer)
  }

  const start = async (key: string, server: Server, spec: ServeSpec): Promise<{ port: number }> => {
    const port = await pickPort()
    server.port = port
    if (server.stopped) {
      reserved.delete(port)
      throw new Error('the server was stopped before it started')
    }
    const remember = splitLines((line) => {
      server.log.push(line)
      if (server.log.length > LOG_LINES) server.log.splice(0, server.log.length - LOG_LINES)
    })
    const [command, ...args] = spec.argv(port)
    const child = spawn(command!, args, {
      cwd: spec.cwd,
      env: spec.env(port),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.child = child
    child.stdout!.on('data', (chunk: Buffer) => remember.push(chunk.toString('utf8')))
    child.stderr!.on('data', (chunk: Buffer) => remember.push(chunk.toString('utf8')))
    let exitMessage: string | null = null
    server.exited = new Promise<void>((resolve) => {
      child.once('error', (err) => {
        exitMessage = `could not run ${command}: ${err.message}`
        resolve()
      })
      child.once('exit', (code, sig) => {
        remember.flush()
        exitMessage ??= sig !== null ? `stopped by ${sig}` : `exited with ${code}`
        resolve()
      })
    })
    void server.exited.then(() => {
      reserved.delete(port)
      // A server that dies on its own while still wanted says so; one that
      // was stopped is no longer the key's.
      if (!current(key, server)) return
      servers.delete(key)
      server.unframe()
      if (server.state.state === 'running')
        set(key, server, { state: 'exited', log: [...server.log], message: exitMessage! })
    })

    const deadline = Date.now() + readyTimeout
    let gone = false
    void server.exited.then(() => (gone = true))
    while (!gone && !server.stopped && Date.now() < deadline) {
      const up = (await canConnect(port, '127.0.0.1')) || (await canConnect(port, '::1'))
      // Stopped while that was in flight: no origin, no state, for a server
      // nobody holds.
      if (server.stopped) break
      if (up && !gone) {
        server.unframe = deps.frameOrigin(pluginServerOrigin(port))
        set(key, server, { state: 'running', port, log: [...server.log] })
        return { port }
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    if (server.stopped) throw new Error('the server was stopped before it was ready')
    const message = gone
      ? `the server ${exitMessage ?? 'exited'} before it was ready`
      : `the server did not answer on port ${port} within ${Math.round(readyTimeout / 1000)} s`
    await stop(key, server)
    set(key, server, { state: 'failed', log: [...server.log], message })
    throw new Error(message)
  }

  return {
    acquire(key, spec) {
      const existing = servers.get(key)
      if (existing !== undefined) {
        existing.refs++
        return existing.ready
      }
      const server: Server = {
        refs: 1,
        port: 0,
        child: null,
        log: [],
        state: { state: 'starting', log: [] },
        ready: Promise.resolve({ port: 0 }),
        exited: Promise.resolve(),
        unframe: () => {},
        stopped: false,
      }
      servers.set(key, server)
      deps.onState(key, server.state)
      server.ready = start(key, server, spec)
      // A failure is reported through `onState`; whoever awaits sees it too.
      server.ready.catch(() => {})
      return server.ready
    },
    async release(key) {
      const server = servers.get(key)
      if (server === undefined) return
      server.refs--
      if (server.refs <= 0) await stop(key, server)
    },
    async stopAll(which = () => true) {
      await Promise.all(
        [...servers].filter(([key]) => which(key)).map(([key, server]) => stop(key, server)),
      )
    },
    state: (key) => servers.get(key)?.state ?? null,
  }
}
