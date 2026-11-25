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
import { AgentRuntime, type AgentRuntimeDeps, type PidState, type SpawnPty } from './pty'
import { TerminalMirror } from './terminal-mirror'
import { TerminalAppearanceProtocol } from './terminal-appearance'

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

export type PresentationLease = () => boolean

/** @public exported for its test */
export interface OpenArgs {
  lease: PresentationLease
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
  /** Keep an exited Pi terminal and its transcript until its session is closed. */
  retainOnExit?: boolean
  /** What the person typed into it, as it goes to the PTY. */
  onInput?(data: string): void
  /** What the program printed. */
  onOutput?(data: string): void
  /** Synchronously close turn admission, with a receipt independent of output. */
  onDraining?(physical?: Promise<void>): void
  /** A failed native launch still has a retained cleanup operation. */
  onStartupCleanup?(work: Promise<void>): void
  /** Physical drain and PTY output settled. A deadline aborts retirement, not running work. */
  onExit?(title?: string, signal?: AbortSignal, nonAdmission?: true): void | Promise<void>
  /** Positive physical proof, but output or exit finalization was abandoned. */
  onExitAbandoned?(): void
  /** Commit staged session state only after durable ownership retirement. */
  onRetired?(): void
  cols?: number
  rows?: number
  /** Written into the record before the program's first byte (the sign-in
   *  notice for a fresh config dir). */
  notice?: string
}

export interface AgentTerminalsDeps {
  /** Tell the renderer `name` about the vault `remote`. */
  emit(remote: string, name: string, payload: unknown, guard?: () => boolean): void
  activationSignal?: AbortSignal
  spawnPty?: SpawnPty
  platform?: AgentRuntimeDeps['platform']
  launchWindowsPty?: AgentRuntimeDeps['launchWindowsPty']
  /** Liveness probe before every signal. Tests must inject one: a fake PTY's
   *  pid may belong to a real process on the machine running them. */
  probePid?: (pid: number) => PidState
  superviseGroup?: AgentRuntimeDeps['superviseGroup']
  /** Compatibility signalling only; the POSIX lease owns its own grace. */
  killGraceMs?: number
  /** Wait for public exit after POSIX proof (or compatibility signalling). */
  killBackstopMs?: number
  pasteSettleMs?: number
  pasteBackstopMs?: number
  log?: (msg: string) => void
}

export interface AgentTerminals {
  open(args: OpenArgs): { ok: true; id: string } | { ok: false; message: string }
  /** A renderer is taking over this terminal: its replayable state. */
  attach(id: string, lease: PresentationLease): Promise<string>
  claim(id: string, lease: PresentationLease): boolean
  discard(id: string, originatingLease: PresentationLease): Promise<boolean>
  write(id: string, data: string, lease: PresentationLease): void
  resize(id: string, cols: number, rows: number, lease: PresentationLease): void
  /** Put text in the terminal's input, unsent. False for a terminal that is gone. */
  paste(id: string, text: string, lease: PresentationLease): boolean
  /** Set the appearance the child sees through OSC colour queries. */
  setAppearance(id: string, appearance: unknown, lease: PresentationLease): void
  /** End the client. Joins physical proof, then bounds output and callbacks.
   * A caller must not race this settlement with a shorter overall deadline. */
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
  appearance: TerminalAppearanceProtocol
  onInput: ((data: string) => void) | undefined
  /** False until a renderer has taken its state: output goes to the record only. */
  attachment?: { lease: PresentationLease }
  lease: PresentationLease
  claimant?: PresentationLease
  retainOnExit: boolean
  draining: boolean
  hidden: boolean
  closeWork?: Promise<void>
  /** True once its TUI has printed and settled; pastes wait until then. */
  ready: boolean
  /** The settle timer is running. */
  settling: boolean
  pending: Array<{ text: string; lease: PresentationLease }>
  timers: ReturnType<typeof setTimeout>[]
}

export function createAgentTerminals(deps: AgentTerminalsDeps): AgentTerminals & {
  /** Join native cleanup for launches that never published a terminal ID. */
  joinFailedStarts(): Promise<void>
} {
  const log = deps.log ?? ((msg: string) => console.log(`[agent-terminals] ${msg}`))
  const settleMs = deps.pasteSettleMs ?? PASTE_SETTLE_MS
  const backstopMs = deps.pasteBackstopMs ?? PASTE_BACKSTOP_MS
  /** Insertion-ordered: the order they were opened. */
  const terminals = new Map<string, Terminal>()
  const failedStarts = new Map<string | null, Promise<void>>()
  deps.activationSignal?.addEventListener(
    'abort',
    () => {
      // Do not wait for the disposer or drop any terminal from the index. Its
      // later close joins the same drain/output/caller operation.
      for (const t of terminals.values()) void t.runtime.kill().catch(() => {})
    },
    { once: true },
  )
  let lastPushed = ''
  const valid = (lease: PresentationLease): boolean => {
    try {
      return lease()
    } catch {
      return false
    }
  }

  const rows = (published = false): TerminalSummary[] =>
    [...terminals.values()]
      .filter((t) => !published || !t.hidden)
      .map(({ id, launchedFor, title }) => ({ id, launchedFor, title }))

  /** Push only when the list actually changed. Every terminal is in the
   *  open vault, the one `remote` names. */
  const pushList = (remote: string): void => {
    const next = rows(true)
    const encoded = JSON.stringify(next)
    if (encoded === lastPushed) return
    deps.emit(remote, 'terminals', next)
    lastPushed = encoded
  }

  function markReady(t: Terminal): void {
    if (t.ready) return
    t.ready = true
    for (const item of t.pending.splice(0))
      if (valid(item.lease)) t.runtime.write(bracketedPaste(item.text))
  }

  function stopInput(t: Terminal): void {
    for (const timer of t.timers.splice(0)) clearTimeout(timer)
    t.pending.length = 0
  }

  async function joinCloses(work: Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(work)
    const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Terminal cleanup failed.')
  }

  const api: ReturnType<typeof createAgentTerminals> = {
    open({
      remote,
      cwd,
      command,
      notInstalled,
      attach,
      retainOnExit,
      onInput,
      onOutput,
      onDraining,
      onStartupCleanup,
      onExit,
      onExitAbandoned,
      onRetired,
      cols,
      rows,
      notice,
      lease,
    }) {
      if (!valid(lease)) return { ok: false, message: 'The presentation is no longer active.' }
      if (deps.activationSignal?.aborted)
        return { ok: false, message: 'The vault was left before the terminal opened.' }
      if (command === null) return { ok: false, message: notInstalled }
      const key = attach ?? null
      const failed = failedStarts.get(key)
      if (failed !== undefined) {
        onStartupCleanup?.(failed)
        return { ok: false, message: 'Previous terminal launch cleanup is unconfirmed.' }
      }
      if ([...terminals.values()].some((t) => t.launchedFor === key && t.draining))
        return { ok: false, message: 'The previous terminal is still closing.' }
      const id = randomUUID()
      const mirror = new TerminalMirror(cols ?? 80, rows ?? 24)
      if (notice !== undefined) mirror.write(notice)
      const runtime = new AgentRuntime({
        ...(deps.activationSignal && { activationSignal: deps.activationSignal }),
        ...(deps.spawnPty === undefined ? {} : { spawnPty: deps.spawnPty }),
        ...(deps.platform === undefined ? {} : { platform: deps.platform }),
        ...(deps.launchWindowsPty === undefined ? {} : { launchWindowsPty: deps.launchWindowsPty }),
        ...(deps.superviseGroup === undefined ? {} : { superviseGroup: deps.superviseGroup }),
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
        appearance: new TerminalAppearanceProtocol(),
        onInput,
        lease,
        retainOnExit: retainOnExit ?? false,
        draining: false,
        hidden: false,
        ready: false,
        settling: false,
        pending: [],
        timers: [],
      }
      mirror.onTitle((title) => {
        t.title = title
        pushList(remote)
      })
      let hasOutput = false
      runtime.onDraining((physical) => {
        t.draining = true
        stopInput(t)
        onDraining?.(physical)
      })
      runtime.onData((data) => {
        hasOutput = true
        if (!t.draining) for (const reply of t.appearance.feed(data)) runtime.write(reply)
        mirror.write(data)
        onOutput?.(data)
        if (t.attachment) {
          const attachment = t.attachment
          deps.emit(
            remote,
            'pty-data',
            { id, data },
            () => terminals.get(id) === t && t.attachment === attachment && valid(attachment.lease),
          )
        }
        // The first output means the TUI is up; a moment later it is reading
        // raw input. Only the fact of output is used, never what it says.
        if (!t.draining && !t.ready && !t.settling) {
          t.settling = true
          t.timers.push(setTimeout(() => markReady(t), settleMs))
        }
      })
      runtime.onExit((e, signal) => {
        const finish = () => {
          signal?.throwIfAborted()
          if (e.nonAdmission) t.retainOnExit = false
          log(`terminal ${id} exited (code ${e.exitCode})`)
          // Notify while still indexed. A failing notification must not let
          // close/reopen miss this terminal or retire its session underneath it.
          deps.emit(remote, 'pty-exit', { id, code: e.exitCode }, () => valid(t.lease))
          if (!t.retainOnExit) {
            t.hidden = true
            pushList(remote)
            mirror.dispose()
          }
          return e.nonAdmission ? onExit?.(t.title, signal, true) : onExit?.(t.title, signal)
        }
        // node-pty delivered the last data, but xterm may still be parsing it.
        return hasOutput ? mirror.serialize().then(finish) : finish()
      })
      if (onExitAbandoned) runtime.onExitAbandoned(onExitAbandoned)
      runtime.onClosed(() => {
        // A hidden terminal still owns its slot until durable retirement succeeds.
        if (!t.retainOnExit) terminals.delete(t.id)
        onRetired?.()
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
        // No terminal id was published, but startup cleanup still owns the
        // launch key. Hand the same promise to any owner of its source files.
        const cleanup = runtime.failedLaunchCleanup
        if (cleanup !== undefined) {
          failedStarts.set(key, cleanup)
          void cleanup.then(
            () => failedStarts.delete(key),
            () => {},
          )
          onStartupCleanup?.(cleanup)
        }
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
      if (!t.draining) t.timers.push(setTimeout(() => markReady(t), backstopMs))
      terminals.set(id, t)
      pushList(remote)
      return { ok: true, id }
    },

    async attach(id, lease) {
      if (!valid(lease)) return ''
      const t = terminals.get(id)
      if (t === undefined) return ''
      const attachment = { lease }
      t.attachment = attachment
      t.claimant = lease
      const state = await t.mirror.serialize()
      if (terminals.get(id) !== t || t.attachment !== attachment || !valid(lease)) return ''
      return state
    },

    claim(id, lease) {
      const t = terminals.get(id)
      if (!valid(lease) || t === undefined || t.draining) return false
      t.claimant = lease
      return true
    },

    async discard(id, originatingLease) {
      const t = terminals.get(id)
      if (t === undefined || t.claimant !== originatingLease) return false
      await api.close(id)
      return true
    },

    write(id, data, lease) {
      const t = terminals.get(id)
      if (!valid(lease) || t === undefined || t.draining) return
      t.onInput?.(data)
      t.runtime.write(data)
    },

    resize(id, cols, rows, lease) {
      const t = terminals.get(id)
      if (!valid(lease) || t === undefined || t.draining) return
      t.runtime.resize(cols, rows)
      t.mirror.resize(cols, rows)
    },

    paste(id, text, lease) {
      const t = terminals.get(id)
      if (!valid(lease) || t === undefined || t.draining) return false
      if (t.ready) t.runtime.write(bracketedPaste(text))
      else t.pending.push({ text, lease })
      return true
    },

    setAppearance(id, appearance, lease) {
      const t = terminals.get(id)
      if (!valid(lease) || t === undefined || t.draining) return
      if (t.appearance.update(appearance)) t.runtime.write(t.appearance.notification())
    },

    close(id) {
      const t = terminals.get(id)
      if (t === undefined) return Promise.resolve()
      // Public exit and its callbacks own retirement. An unconfirmed exit is
      // not a synthetic close; a retained transcript is retired only here.
      t.attachment = undefined
      return (t.closeWork ??= t.runtime.kill().then(() => {
        if (terminals.get(id) !== t) return
        t.hidden = true
        pushList(t.remote)
        t.mirror.dispose()
        terminals.delete(id)
      }))
    },

    async joinFailedStarts() {
      await joinCloses([...failedStarts.values()])
    },

    async closeAll() {
      await joinCloses([
        ...failedStarts.values(),
        ...[...terminals.keys()].map((id) => api.close(id)),
      ])
    },

    list: () => rows(),

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
