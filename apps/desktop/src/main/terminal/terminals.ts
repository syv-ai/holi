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
 * Pure Node: tests inject the spawn, the clock-free pieces and the push.
 */
import { basename } from 'node:path'
import { defaultProbePid, type PidState } from '../process-group'
import { defaultSpawnPty, nativeLoadHint, signalPty, type PtyProcess, type SpawnPty } from './pty'

/** A terminal as the panel lists it. */
export interface TerminalInfo {
  id: string
  /** `zsh`, `zsh 2`: the shell's name, numbered after the first. */
  title: string
  /** The exit code once the shell has exited; the panel keeps an exited
   *  terminal until its ×, so its last output stays readable. */
  exitCode: number | null
}

export type TerminalOpened = { ok: true; terminal: TerminalInfo } | { ok: false; message: string }

/** What main pushes about a terminal. */
export type TerminalEvent =
  | { kind: 'data'; remote: string; id: string; data: string }
  | { kind: 'exit'; remote: string; id: string; exitCode: number }

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
}

/** How much output each terminal keeps for a replay. */
export const REPLAY_BYTES = 256 * 1024

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
}

export function createTerminals(deps: TerminalsDeps): Terminals {
  const spawn = deps.spawnPty ?? defaultSpawnPty
  const probe = deps.probePid ?? defaultProbePid
  const shell = deps.shell ?? (() => process.env.SHELL || '/bin/zsh')
  const baseEnv = deps.baseEnv ?? (() => process.env)
  const graceMs = deps.killGraceMs ?? 1_500
  const live = new Map<string, Live>()
  let counter = 0

  const info = (t: Live): TerminalInfo => ({ id: t.id, title: t.title, exitCode: t.exitCode })

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
        pty = spawn(file, ['-l'], {
          cwd: root,
          env: shellEnv(baseEnv(), deps.binDir?.() ?? null),
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
      }
      live.set(id, t)
      pty.onData((data) => {
        t.output = (t.output + data).slice(-REPLAY_BYTES)
        if (live.get(id) === t) deps.send({ kind: 'data', remote, id, data })
      })
      pty.onExit(({ exitCode }) => {
        t.exitCode = exitCode
        resolveExit()
        if (live.get(id) === t) deps.send({ kind: 'exit', remote, id, exitCode })
      })
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
