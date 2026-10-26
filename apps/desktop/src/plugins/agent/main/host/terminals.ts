/**
 * Holi's terminals onto the agent.
 *
 * Each is a PTY running what its caller asked (`AgentProvider.terminal`).
 * For a background session that is a **window onto it**: the provider's list
 * (where sessions are started and picked) or one session, and closing it only
 * detaches. For a session Holi runs itself (`pty-sessions.ts`) the terminal
 * is the session, and that module decides when it closes.
 *
 * **A terminal's launch says nothing about what it shows now.** `←` inside an
 * attached session turns the same process into the list, and Enter there
 * attaches any other session. So `launchedFor` is only what Holi asked for,
 * used to reuse a window it opened; the label is the terminal's own title.
 * Nothing here parses the TUI.
 *
 * What changes is told to the renderer as the agent's events, about the
 * vault the terminal was opened in: `pty-data` and `pty-exit` for one
 * terminal, `terminals` for the list.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { randomUUID } from 'node:crypto'
import type { TerminalCommand } from '../provider'
import { AgentRuntime, type PidState, type SpawnPty } from './pty'
import { TerminalMirror } from './terminal-mirror'

/** Text pasted into a terminal, unsent: the framing is the terminal's own, and
 *  there is no `\r`, so nothing Holi writes can submit a draft. */
const bracketedPaste = (text: string): string => `\x1b[200~${text}\x1b[201~`

/** After a terminal's first output, how long to let the TUI settle into raw
 *  mode before a held paste goes in. */
const PASTE_SETTLE_MS = 200
/** The cap on holding a paste for a terminal that never prints. */
const PASTE_BACKSTOP_MS = 5_000

export interface TerminalSummary {
  id: string
  /** The session Holi opened this terminal for, or null for the list. What it
   *  shows *now* may differ (see the module note). */
  launchedFor: string | null
  /** What the program in it last set as the terminal title; '' until it does. */
  title: string
}

/** @public exported for its test */
export interface OpenArgs {
  /** The vault it is opened in, which its events are about. */
  remote: string
  /** The vault clone it runs in. */
  cwd: string
  /** What it runs; null when the agent is not on this machine. */
  command: TerminalCommand | null
  /** What to answer when `command` is null. */
  notInstalled: string
  /** The session it is opened for; omitted for a background provider's list. */
  attach?: string
  /** What the person typed into it, as it goes to the PTY. */
  onInput?(data: string): void
  /** What the program printed. */
  onOutput?(data: string): void
  /** Its process ended, by itself or closed. */
  onExit?(): void
  cols?: number
  rows?: number
  /** Written into the record before the program's first byte (the sign-in
   *  notice for a fresh config dir). */
  notice?: string
}

export interface AgentTerminalsDeps {
  /** Tell the renderer `name` about the vault `remote`. */
  emit(remote: string, name: string, payload: unknown): void
  spawnPty?: SpawnPty
  /** Liveness probe before every signal. Tests must inject one: a fake PTY's
   *  pid may belong to a real process on the machine running them. */
  probePid?: (pid: number) => PidState
  killGraceMs?: number
  killBackstopMs?: number
  pasteSettleMs?: number
  pasteBackstopMs?: number
  log?: (msg: string) => void
}

export interface AgentTerminals {
  open(args: OpenArgs): { ok: true; id: string } | { ok: false; message: string }
  /** A renderer is taking over this terminal: its replayable state. */
  attach(id: string): Promise<string>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /** Put text in the terminal's input, unsent. False for a terminal that is gone. */
  paste(id: string, text: string): boolean
  /** Detach: end the client. The session it shows keeps running. */
  close(id: string): Promise<void>
  closeAll(): Promise<void>
  list(): TerminalSummary[]
  /** The terminal Holi opened for this session, if it is still open. */
  launchedFor(sessionId: string): string | null
  /** The terminal Holi opened on the list, if it is still open. */
  listTerminal(): string | null
}

interface Terminal {
  id: string
  remote: string
  launchedFor: string | null
  title: string
  runtime: AgentRuntime
  mirror: TerminalMirror
  onInput: ((data: string) => void) | undefined
  onExit: (() => void) | undefined
  /** False until a renderer has taken its state: output goes to the record only. */
  attached: boolean
  /** True once its TUI has printed and settled; pastes wait until then. */
  ready: boolean
  /** The settle timer is running. */
  settling: boolean
  pending: string[]
  timers: ReturnType<typeof setTimeout>[]
}

export function createAgentTerminals(deps: AgentTerminalsDeps): AgentTerminals {
  const log = deps.log ?? ((msg: string) => console.log(`[agent-terminals] ${msg}`))
  const settleMs = deps.pasteSettleMs ?? PASTE_SETTLE_MS
  const backstopMs = deps.pasteBackstopMs ?? PASTE_BACKSTOP_MS
  /** Insertion-ordered: the order they were opened. */
  const terminals = new Map<string, Terminal>()
  let lastPushed = ''

  const list = (): TerminalSummary[] =>
    [...terminals.values()].map(({ id, launchedFor, title }) => ({ id, launchedFor, title }))

  /** Push only when the list actually changed. Every terminal is in the
   *  open vault, the one `remote` names. */
  const pushList = (remote: string): void => {
    const next = list()
    const encoded = JSON.stringify(next)
    if (encoded === lastPushed) return
    lastPushed = encoded
    deps.emit(remote, 'terminals', next)
  }

  function markReady(t: Terminal): void {
    if (t.ready) return
    t.ready = true
    for (const text of t.pending.splice(0)) t.runtime.write(bracketedPaste(text))
  }

  function drop(t: Terminal): void {
    for (const timer of t.timers.splice(0)) clearTimeout(timer)
    t.pending.length = 0
    terminals.delete(t.id)
  }

  const api: AgentTerminals = {
    open({ remote, cwd, command, notInstalled, attach, onInput, onOutput, onExit, cols, rows, notice }) {
      if (command === null) return { ok: false, message: notInstalled }
      const id = randomUUID()
      const mirror = new TerminalMirror(cols ?? 80, rows ?? 24)
      if (notice !== undefined) mirror.write(notice)
      const runtime = new AgentRuntime({
        ...(deps.spawnPty === undefined ? {} : { spawnPty: deps.spawnPty }),
        ...(deps.probePid === undefined ? {} : { probePid: deps.probePid }),
        ...(deps.killGraceMs === undefined ? {} : { killGraceMs: deps.killGraceMs }),
        ...(deps.killBackstopMs === undefined ? {} : { killBackstopMs: deps.killBackstopMs }),
      })
      const t: Terminal = {
        id,
        remote,
        launchedFor: attach ?? null,
        title: '',
        runtime,
        mirror,
        onInput,
        onExit,
        attached: false,
        ready: false,
        settling: false,
        pending: [],
        timers: [],
      }
      mirror.onTitle((title) => {
        t.title = title
        pushList(remote)
      })
      runtime.onData((data) => {
        mirror.write(data)
        onOutput?.(data)
        if (t.attached) deps.emit(remote, 'pty-data', { id, data })
        // The first output means the TUI is up; a moment later it is reading
        // raw input. Only the fact of output is used, never what it says.
        if (!t.ready && !t.settling) {
          t.settling = true
          t.timers.push(setTimeout(() => markReady(t), settleMs))
        }
      })
      runtime.onExit((e) => {
        log(`terminal ${id} exited (code ${e.exitCode})`)
        drop(t)
        mirror.dispose()
        deps.emit(remote, 'pty-exit', { id, code: e.exitCode })
        pushList(remote)
        onExit?.()
      })
      try {
        runtime.start({
          bin: command.bin,
          args: command.args,
          cwd,
          env: command.env,
          ...(cols === undefined ? {} : { cols }),
          ...(rows === undefined ? {} : { rows }),
        })
      } catch (err: unknown) {
        mirror.dispose()
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
      t.timers.push(setTimeout(() => markReady(t), backstopMs))
      terminals.set(id, t)
      pushList(remote)
      return { ok: true, id }
    },

    async attach(id) {
      const t = terminals.get(id)
      if (t === undefined) return ''
      // Serialise BEFORE opening the tap: a chunk that lands mid-serialise goes
      // to the record only, never both replayed and streamed. Closed first,
      // because a re-attach (a pane move remounts the view) finds it open.
      t.attached = false
      const state = await t.mirror.serialize()
      if (terminals.has(id)) t.attached = true
      return state
    },

    write(id, data) {
      const t = terminals.get(id)
      if (t === undefined) return
      t.onInput?.(data)
      t.runtime.write(data)
    },

    resize(id, cols, rows) {
      const t = terminals.get(id)
      if (t === undefined) return
      t.runtime.resize(cols, rows)
      t.mirror.resize(cols, rows)
    },

    paste(id, text) {
      const t = terminals.get(id)
      if (t === undefined) return false
      if (t.ready) t.runtime.write(bracketedPaste(text))
      else t.pending.push(text)
      return true
    },

    async close(id) {
      const t = terminals.get(id)
      if (t === undefined) return
      // The exit handler drops it and tells the renderer. A client that never
      // reports its exit is dropped here once the kill path gives up on it.
      await t.runtime.kill()
      if (terminals.get(id) === t) {
        drop(t)
        t.mirror.dispose()
        deps.emit(t.remote, 'pty-exit', { id, code: -1 })
        pushList(t.remote)
        t.onExit?.()
      }
    },

    async closeAll() {
      await Promise.all([...terminals.keys()].map((id) => api.close(id)))
    },

    list,

    launchedFor(sessionId) {
      for (const t of terminals.values()) if (t.launchedFor === sessionId) return t.id
      return null
    },

    listTerminal() {
      for (const t of terminals.values()) if (t.launchedFor === null) return t.id
      return null
    },
  }
  return api
}
