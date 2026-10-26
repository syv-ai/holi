/**
 * The bottom panel's shells (docs/features/status-bar.md): the person's login
 * shell in a PTY, in the open vault's clone, as many as they open.
 *
 * Core's, not the agent plugin's: a terminal is a terminal whatever the
 * vault runs, and core may not import a plugin. The PTY is the shared one
 * (`pty.ts`).
 *
 * Main keeps them; the renderer gets bytes and sends keystrokes and sizes,
 * each naming the vault and the terminal, and one about any other vault is
 * dropped. They live until their × or until Holi leaves the vault
 * (`closeAll`, from the vault host's leave hook) or quits: closing the panel
 * only hides them.
 *
 * Each also reports where it is and the git work there (`context` pushes),
 * for the panel's context chips: the cwd from the shell integration's OSC 7
 * at every prompt (`shell-integration.ts`), validated here, or from the OS
 * for a shell without it; the git summary read again after each prompt
 * (`terminal-context.ts`). A context goes out naming its vault and terminal,
 * like the bytes.
 *
 * Pure Node: tests inject the spawn, the clock-free pieces and the push.
 */
import { basename } from 'node:path'
import { defaultProbePid, type PidState } from '../process-group'
import { defaultSpawnPty, nativeLoadHint, signalPty, type PtyProcess, type SpawnPty } from './pty'
import { defaultIntegrationDir, shellLaunch } from './shell-integration'
import {
  createOsc7Scanner,
  gitSummary as defaultGitSummary,
  homeLabel,
  isDirectory as defaultIsDirectory,
  parseOsc7,
  processCwd as defaultProcessCwd,
  type GitSummary,
  type TerminalContext,
} from './terminal-context'

export type { TerminalContext }

/** A terminal as the panel lists it. */
export interface TerminalInfo {
  id: string
  /** `zsh`, `zsh 2`: the shell's name, numbered after the first. */
  title: string
  /** The exit code once the shell has exited; the panel keeps an exited
   *  terminal until its ×, so its last output stays readable. */
  exitCode: number | null
  /** Where it is and the git work there, for the context chips; null until
   *  first read. */
  context: TerminalContext | null
}

export type TerminalOpened = { ok: true; terminal: TerminalInfo } | { ok: false; message: string }

/** What main pushes about a terminal. */
export type TerminalEvent =
  | { kind: 'data'; remote: string; id: string; data: string }
  | { kind: 'exit'; remote: string; id: string; exitCode: number }
  | { kind: 'context'; remote: string; id: string; context: TerminalContext }

export interface Terminals {
  create(args: { remote: string; root: string; cols: number; rows: number }): TerminalOpened
  list(remote: string): TerminalInfo[]
  /** What it printed so far (the last `REPLAY_BYTES`), for an xterm built
   *  after the output: the panel's first show, or a renderer reload. */
  replay(remote: string, id: string): string
  write(remote: string, id: string, data: string): void
  resize(remote: string, id: string, cols: number, rows: number): void
  /** Stop one (its ×), and forget it. Resolves once it is gone. */
  kill(remote: string, id: string): Promise<void>
  /** Stop every one: leaving the vault, quitting. */
  closeAll(): Promise<void>
}

export interface TerminalsDeps {
  send(event: TerminalEvent): void
  spawnPty?: SpawnPty
  probePid?: (pid: number) => PidState
  /** The shell to run: `$SHELL`, else `/bin/zsh`. */
  shell?: () => string
  /** The environment it starts with, before Holi's additions. */
  baseEnv?: () => NodeJS.ProcessEnv
  /** Prepended to PATH, so `holi` answers in the shell as it does for the
   *  agent. */
  binDir?: () => string | null
  /** A shell that will not go on SIGHUP gets SIGKILL after this. */
  killGraceMs?: number
  /** Where the shell-integration shim lives (`shell-integration.ts`); null
   *  starts shells without it. */
  integrationDir?: () => string | null
  /** The context chips' sources (`terminal-context.ts`). */
  gitSummary?: (cwd: string) => Promise<GitSummary | null>
  processCwd?: (pid: number) => Promise<string | null>
  isDirectory?: (path: string) => Promise<boolean>
  home?: string
  /** How long after a prompt (or, without the integration, after output
   *  stops) the context is read again. */
  contextDelayMs?: number
}

/** Without the integration, the OS is asked for the cwd at most this often. */
const POLL_MIN_INTERVAL_MS = 2_000

/** How much output each terminal keeps for a replay. */
const REPLAY_BYTES = 256 * 1024

/** Environment that must not leak into a person's shell: Electron's own
 *  switches, which would make a `node` there behave as Electron. */
const DROP_ENV = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|ELECTRON_ENABLE_LOGGING)$/

/** The environment a panel shell starts with. Exported for the test. */
export function shellEnv(base: NodeJS.ProcessEnv, binDir: string | null): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !DROP_ENV.test(key)) env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Holi'
  if (binDir !== null && binDir !== '') {
    env.PATH = env.PATH ? `${binDir}:${env.PATH}` : binDir
  }
  return env
}

interface Live {
  id: string
  remote: string
  title: string
  pty: PtyProcess
  exitCode: number | null
  output: string
  exited: Promise<void>
  /** Where the shell is, as last validated. */
  cwd: string
  context: TerminalContext | null
  /** Whether it has ever reported its cwd itself (OSC 7). */
  integrated: boolean
  timers: Set<ReturnType<typeof setTimeout>>
}

export function createTerminals(deps: TerminalsDeps): Terminals {
  const spawn = deps.spawnPty ?? defaultSpawnPty
  const probe = deps.probePid ?? defaultProbePid
  const shell = deps.shell ?? (() => process.env.SHELL || '/bin/zsh')
  const baseEnv = deps.baseEnv ?? (() => process.env)
  const graceMs = deps.killGraceMs ?? 1_500
  const integrationDir = deps.integrationDir ?? defaultIntegrationDir
  const summarize = deps.gitSummary ?? ((cwd: string) => defaultGitSummary(cwd))
  const askCwd = deps.processCwd ?? ((pid: number) => defaultProcessCwd(pid))
  const isDirectory = deps.isDirectory ?? defaultIsDirectory
  const delayMs = deps.contextDelayMs ?? 150
  const live = new Map<string, Live>()
  let counter = 0

  const info = (t: Live): TerminalInfo => ({
    id: t.id,
    title: t.title,
    exitCode: t.exitCode,
    context: t.context,
  })

  /** A timer that dies with its terminal. */
  function later(t: Live, ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      t.timers.delete(timer)
      fn()
    }, ms)
    t.timers.add(timer)
    return timer
  }

  /**
   * Read the context again, soon: several asks in a row (a prompt after a
   * cd) are one read, and one asked while a read runs follows it.
   */
  function contextUpdater(t: Live, remote: string): () => void {
    let pending: ReturnType<typeof setTimeout> | null = null
    let running = false
    let again = false
    const read = async () => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        const cwd = t.cwd
        const git = await summarize(cwd).catch(() => null)
        const next: TerminalContext = { cwd, label: homeLabel(cwd, deps.home), git }
        if (live.get(t.id) !== t) return
        if (JSON.stringify(next) !== JSON.stringify(t.context)) {
          t.context = next
          deps.send({ kind: 'context', remote, id: t.id, context: next })
        }
      } finally {
        running = false
        if (again && live.get(t.id) === t) {
          again = false
          void read()
        }
      }
    }
    return () => {
      if (pending !== null) {
        clearTimeout(pending)
        t.timers.delete(pending)
      }
      pending = later(t, delayMs, () => {
        pending = null
        void read()
      })
    }
  }

  /** `zsh`, then `zsh 2`, `zsh 3`: the lowest number not in use. */
  function titleFor(remote: string, name: string): string {
    const taken = new Set([...live.values()].filter((t) => t.remote === remote).map((t) => t.title))
    if (!taken.has(name)) return name
    for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`
  }

  function find(remote: string, id: string): Live | null {
    const t = live.get(id)
    return t !== undefined && t.remote === remote ? t : null
  }

  async function stop(t: Live): Promise<void> {
    live.delete(t.id)
    for (const timer of t.timers) clearTimeout(timer)
    t.timers.clear()
    if (t.exitCode !== null) return
    // SIGHUP is what a closing terminal sends, and what a shell passes to
    // its jobs; a shell ignoring it gets SIGKILL.
    signalPty(t.pty, 'SIGHUP', probe)
    const timer = setTimeout(() => {
      if (t.exitCode === null) signalPty(t.pty, 'SIGKILL', probe)
    }, graceMs)
    await Promise.race([t.exited, new Promise((r) => setTimeout(r, graceMs + 1_000))])
    clearTimeout(timer)
  }

  return {
    create({ remote, root, cols, rows }) {
      const file = shell()
      let pty: PtyProcess
      try {
        // A login shell, so the person's profile (PATH, prompt) is there as
        // in their own terminal: an app opened from the Dock has neither.
        // With the integration where Holi has one, which reports the cwd.
        const env = shellEnv(baseEnv(), deps.binDir?.() ?? null)
        const launch = shellLaunch(file, env, integrationDir())
        pty = spawn(file, launch.args, {
          cwd: root,
          env: { ...env, ...launch.env },
          cols,
          rows,
        })
      } catch (err) {
        console.error('[terminal] spawn failed:', err)
        return {
          ok: false,
          message:
            nativeLoadHint(err) ??
            `Could not start ${file}: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      counter += 1
      const id = `t${counter}`
      let resolveExit: () => void = () => {}
      const exited = new Promise<void>((r) => (resolveExit = r))
      const t: Live = {
        id,
        remote,
        title: titleFor(remote, basename(file)),
        pty,
        exitCode: null,
        output: '',
        exited,
        cwd: root,
        context: null,
        integrated: false,
        timers: new Set(),
      }
      live.set(id, t)
      const refresh = contextUpdater(t, remote)
      const scan = createOsc7Scanner()
      /** Which OSC 7 is newest: a slow check must not undo a later cd. */
      let reported = 0
      let poll: ReturnType<typeof setTimeout> | null = null
      let lastPoll = 0
      const pollCwd = () => {
        if (poll !== null || t.integrated) return
        const wait = Math.max(delayMs * 3, lastPoll + POLL_MIN_INTERVAL_MS - Date.now())
        poll = later(t, wait, () => {
          poll = null
          lastPoll = Date.now()
          if (t.integrated || t.exitCode !== null) return
          void askCwd(pty.pid).then(async (cwd) => {
            if (cwd !== null && !t.integrated && (await isDirectory(cwd))) t.cwd = cwd
            refresh()
          })
        })
      }
      pty.onData((data) => {
        t.output = (t.output + data).slice(-REPLAY_BYTES)
        if (live.get(id) === t) deps.send({ kind: 'data', remote, id, data })
        for (const payload of scan(data)) {
          // Every prompt prints one: the cwd, and a moment the git work may
          // have changed.
          const path = parseOsc7(payload)
          if (path === null) continue
          t.integrated = true
          const seq = ++reported
          void isDirectory(path).then((ok) => {
            if (seq !== reported) return
            if (ok) t.cwd = path
            refresh()
          })
        }
        if (!t.integrated) pollCwd()
      })
      pty.onExit(({ exitCode }) => {
        t.exitCode = exitCode
        resolveExit()
        for (const timer of t.timers) clearTimeout(timer)
        t.timers.clear()
        if (live.get(id) === t) deps.send({ kind: 'exit', remote, id, exitCode })
      })
      refresh()
      return { ok: true, terminal: info(t) }
    },

    list: (remote) => [...live.values()].filter((t) => t.remote === remote).map(info),

    replay: (remote, id) => find(remote, id)?.output ?? '',

    write(remote, id, data) {
      const t = find(remote, id)
      if (t !== null && t.exitCode === null) t.pty.write(data)
    },

    resize(remote, id, cols, rows) {
      const t = find(remote, id)
      if (t === null || t.exitCode !== null) return
      try {
        t.pty.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
      } catch {
        // Raced with exit.
      }
    },

    async kill(remote, id) {
      const t = find(remote, id)
      if (t !== null) await stop(t)
    },

    async closeAll() {
      await Promise.all([...live.values()].map((t) => stop(t)))
    },
  }
}
