/**
 * Sessions Holi runs itself, for a provider with no supervisor of its own
 * (docs/features/agent-sessions.md, Providers): Codex, and any agent that
 * only has a CLI.
 *
 * **The terminal is the session.** Holi starts the CLI in a PTY in the vault
 * clone; the session lives exactly as long as that process. Closing its tab
 * leaves it running (the sidebar row brings it back), and Stop ends it. Holi
 * names it by an id of its own, `p` and twelve hex digits, which its hooks
 * carry back (`TerminalOpts.session`).
 *
 * **What it is doing comes from signals, not text**: its hooks when the
 * provider has `turns`, and the terminal stream for the rest
 * (`pty-signals.ts`). A notification during a turn is a question for the
 * person; the next thing they type answers it and the turn goes on.
 *
 * Every turn goes through the vault's turn bracket (`bracket`), so sync
 * pauses and the turn is recorded like a background session's.
 *
 * **A fenced session** runs in a folder of Holi's instead of the clone
 * (`fenced.ts`), with no Holi commands on its `PATH`: what it wrote is
 * copied back as each turn ends, before the turn's bracket closes, and
 * once more when it exits.
 *
 * **A sign-in is one too.** A provider whose sessions its supervisor runs
 * (Claude Code) has no session here but one: the terminal that runs its own
 * sign-in (`login`). Once signed in that terminal is a working session in the
 * vault, so it is listed, attached and stopped like the rest while its process
 * lives. Nothing reports its turns (its hooks name a background job, and it is
 * none), and its stream is not read for them either: Holi does not infer what
 * Claude Code is doing, so it reads idle and pauses no sync.
 *
 * One per vault activation: the agent starts in a vault, and these sessions
 * end when it stops there.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { SessionState, SessionSummary } from '../claude/listing'
import {
  firstSpawnNotice,
  hasBackground,
  isProviderId,
  type AgentProvider,
  type ProviderId,
  type VaultRef,
} from '../provider'
import { bounded } from './bounded'
import { createTurnSignals, type TurnSignals } from './pty-signals'
import type { ActionResult, Geometry, OpenResult, StartResult } from './sessions'
import type { AgentTerminals } from './terminals'

/** Holi's id for a session it runs: never a conversation id or job id. */
export const PTY_SESSION_ID = /^p[0-9a-f]{12}$/
/** @public */
export const CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAST_MAX = 50
/** A fenced terminal is gone, but its final copy result remains readable. */
const FENCED_RESULT_MS = 10 * 60_000

interface PastStore {
  read(): Promise<SessionSummary[]>
  write(list: SessionSummary[]): Promise<void>
}

/** Strictly validate local history; malformed rows are never resumed. */
export function parsePastFile(raw: unknown): Record<string, SessionSummary[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const parsed: Record<string, SessionSummary[]> = {}
  for (const [remote, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue
    parsed[remote] = value.filter((row): row is SessionSummary => {
      if (!row || typeof row !== 'object') return false
      const session = row as Partial<SessionSummary>
      return (
        typeof session.id === 'string' &&
        PTY_SESSION_ID.test(session.id) &&
        isProviderId(session.provider) &&
        typeof session.name === 'string' &&
        session.state === 'idle' &&
        typeof session.startedAt === 'number' &&
        Number.isFinite(session.startedAt) &&
        typeof session.conversationId === 'string' &&
        CONVERSATION_ID.test(session.conversationId)
      )
    })
  }
  return parsed
}

const NEW_SESSION = 'New session'

/** The longest name a session takes from its first ask. */
const NAME_MAX = 80

export interface PtySessionsDeps {
  vault: VaultRef
  /** The agents it may run, read per start: this machine's harnesses
   *  change while the vault is open. One with `background` runs here only
   *  for its sign-in (`login`). */
  providers(): readonly AgentProvider[]
  terminals: Pick<AgentTerminals, 'open' | 'close' | 'paste' | 'list'>
  /** The vault's turn bracket: sync pauses and the turn is recorded. */
  bracket(id: string, edge: 'begin' | 'end' | 'forget'): unknown | Promise<unknown>
  /** Holi's generated commands, first on every session's `PATH`. */
  binDir(): string | null
  /** The list changed. */
  onChange(list: SessionSummary[]): void
  /** Per-vault local history store, kept outside the synced clone. */
  past?: PastStore
  onPast?(list: SessionSummary[]): void
  idleMs?: number
  log?: (msg: string) => void
  /** Revokes admission synchronously when this vault activation is invalidated. */
  activationSignal?: AbortSignal
}

/** How a fenced session's copy back went: why it failed, or what it left
 *  out. Its row carries it (`outcome`/`error`, `message`) until the next. */
export interface FenceCopy {
  error?: string
  leftOut?: string
}

/** A session fenced to a folder of Holi's (`fenced.ts`). @public: kept for its test. */
export interface Fence {
  dir: string
  /** A folder of Holi's outside `dir` for the agent's own state. */
  state: string
  /** The scratch owner can revoke admission before the native call. */
  canLaunch?(): boolean
  /** A turn ended: copy back what it wrote, and say how that went. */
  turnEnded(): Promise<FenceCopy>
  /** The session's process exited; report its final copy before losing the row. */
  exited(signal?: AbortSignal): Promise<FenceCopy>
}

export interface PtySessions {
  sessions(): SessionSummary[]
  past(): Promise<SessionSummary[]>
  hasPast(id: string): Promise<boolean>
  reopen(id: string, size: Geometry): Promise<StartResult>
  duplicate(id: string, size: Geometry): Promise<StartResult>
  has(id: string): boolean
  /** Whether a terminal is one of these sessions' own, which a detach must
   *  leave running. */
  ownsTerminal(terminalId: string): boolean
  /** The session's terminal. */
  terminalOf(id: string): string | null
  /** A new session of `provider`: its first message `prompt`, a
   *  conversation to pick up (`resume`), or the provider's own sign-in
   *  (`login`), which is the only session a background provider has here. */
  start(
    provider: ProviderId,
    args: Geometry & {
      login?: boolean
      name?: string
      prompt?: string
      resume?: string
      sessionId?: string
      fork?: string
      fence?: Fence
      onStartupCleanup?(work: Promise<void>): void
    },
  ): Promise<StartResult>
  /** Put text in a session's input, unsent. */
  send(id: string, text: string): OpenResult
  stop(id: string): Promise<ActionResult>
  /** A turn edge from the provider's hook. */
  noteTurn(id: string, active: boolean): void
  /** What the session's hook said about it. */
  noteConversation(id: string, about: { name?: string; conversationId?: string }): void
  /** What the session's hook said of its context and model
   *  (`holi-signal status`). */
  noteStatus(id: string, status: { contextPercent?: number; model?: string }): void
  /** The agent a live session runs. */
  providerOf(id: string): ProviderId | null
  /** End every session. */
  leave(): Promise<void>
}

interface Finalization {
  pending: Set<Promise<unknown>>
  failures: Set<unknown>
}

interface Session {
  finalization: Finalization
  id: string
  provider: ProviderId
  name: string | null
  startedAt: number
  terminalId: string
  conversationId?: string
  /** The terminal that signs its provider in (`login`). */
  signIn: boolean
  persistConversation: boolean
  /** A notification asked for the person, and nothing was typed since. */
  attention: boolean
  signals: TurnSignals
  /** How its last copy back went, when it is fenced. */
  copy?: FenceCopy
  contextPercent?: number
  model?: string
  copying?: boolean
  draining?: boolean
  forgetTurn?: boolean
  exitWork?: Promise<void>
  closeWork?: Promise<void>
}

/**
 * A name from the first line of an ask.
 * @public exported for its test
 */
export function nameOf(text: string): string | null {
  const line = text.trim().split('\n', 1)[0]?.trim() ?? ''
  if (line === '') return null
  return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1)}…` : line
}

export function createPtySessions(deps: PtySessionsDeps): PtySessions {
  const log = deps.log ?? ((msg: string) => console.log(`[agent-pty] ${msg}`))
  const sessions = new Map<string, Session>()
  const finishedFences = new Map<
    string,
    { row: SessionSummary; timer?: ReturnType<typeof setTimeout> }
  >()
  const memoryPast: PastStore = (() => {
    let rows: SessionSummary[] = []
    return {
      read: async () => rows,
      write: async (next) => {
        rows = next
      },
    }
  })()
  const pastStore = deps.past ?? memoryPast
  let pastQueue: Promise<unknown> = Promise.resolve()
  // Keep mutations in their original order until a write commits the whole
  // prefix. Replaying just an older failed removal after a newer append would
  // delete the conversation that has since closed again.
  const pendingPast: Array<(rows: SessionSummary[]) => SessionSummary[]> = []
  const flushPast = (): Promise<void> => {
    const next = pastQueue.then(async () => {
      const batch = pendingPast.slice()
      if (batch.length === 0) return
      const rows = batch.reduce((rows, change) => change(rows), await pastStore.read())
      await pastStore.write(rows)
      pendingPast.splice(0, batch.length)
      deps.onPast?.(rows)
    })
    pastQueue = next.catch((err: unknown) => {
      log(`closed sessions: ${String(err)}`)
    })
    return next
  }
  const changePast = (change: (rows: SessionSummary[]) => SessionSummary[]): Promise<void> => {
    pendingPast.push(change)
    return flushPast()
  }
  async function retryPastFailures(): Promise<void> {
    await bounded(flushPast(), 'PTY history retry')
  }

  const reopening = new Set<string>()
  const trackFinalizer = <T>(owner: Finalization, promise: Promise<T>): Promise<T> => {
    owner.pending.add(promise)
    void promise.then(
      () => {
        owner.pending.delete(promise)
      },
      (err: unknown) => {
        owner.failures.add(err)
        owner.pending.delete(promise)
      },
    )
    return promise
  }
  /** A sign-in still starting, by provider. */
  const signingIn = new Map<ProviderId, Promise<StartResult>>()
  const configured = new Map<ProviderId, Promise<{ dir: string } | null>>()
  let left = deps.activationSignal?.aborted === true
  const starting = new Set<Promise<StartResult>>()
  deps.activationSignal?.addEventListener(
    'abort',
    () => {
      left = true
      for (const s of sessions.values()) fenceAdmission(s)
    },
    { once: true },
  )
  let lastPushed = ''

  const runBracket = (owner: Finalization, id: string, edge: 'begin' | 'end' | 'forget'): void => {
    let work: Promise<unknown>
    try {
      work = Promise.resolve(deps.bracket(id, edge))
    } catch (err) {
      owner.failures.add(err)
      return
    }
    void trackFinalizer(owner, work)
  }

  const stateOf = (s: Session): SessionState =>
    s.copying ? 'working' : s.attention ? 'needs-you' : s.signals.inTurn ? 'working' : 'idle'

  /** A session's name: what Holi was told, else the title its program set. */
  const nameFor = (s: Session, lastTitle?: string): string => {
    if (s.name !== null) return s.name
    const title = (
      lastTitle ??
      deps.terminals.list().find((t) => t.id === s.terminalId)?.title ??
      ''
    ).trim()
    return title === '' ? NEW_SESSION : title
  }

  const summaries = (excluding?: Session): SessionSummary[] => [
    ...[...sessions.values()]
      .filter((s) => s !== excluding && !finishedFences.has(s.id))
      .map((s) => ({
        id: s.id,
        provider: s.provider,
        name: nameFor(s),
        state: stateOf(s),
        ...(s.attention ? { waitingFor: 'an answer' } : {}),
        startedAt: s.startedAt,
        ...(s.conversationId === undefined ? {} : { conversationId: s.conversationId }),
        // A fenced session whose writes did not reach the vault says why.
        ...(s.copy?.error === undefined ? {} : { outcome: 'failed' as const, error: s.copy.error }),
        ...(s.copy?.leftOut === undefined ? {} : { message: s.copy.leftOut }),
        ...(s.contextPercent === undefined ? {} : { contextPercent: s.contextPercent }),
        ...(s.model === undefined ? {} : { model: s.model }),
        ...(s.copying ? { copying: true } : {}),
        ...(s.signIn ? { signIn: true } : {}),
      })),
    ...[...finishedFences.values()].map(({ row }) => row),
  ]

  function push(excluding?: Session): void {
    const next = summaries(excluding)
    const encoded = JSON.stringify(next)
    if (encoded === lastPushed) return
    deps.onChange(next)
    lastPushed = encoded
  }

  function fenceAdmission(s: Session): void {
    if (s.draining) return
    s.draining = true
    s.forgetTurn = s.signals.inTurn
    s.signals.dispose()
  }

  async function joinFinalizers(owner: Finalization): Promise<void> {
    while (owner.pending.size > 0) await Promise.allSettled([...owner.pending])
  }

  function assertFinalized(owner: Finalization): void {
    if (owner.failures.size === 1) throw [...owner.failures][0]
    if (owner.failures.size > 1)
      throw new AggregateError([...owner.failures], 'PTY session finalization failed.')
  }

  function saveClosed(s: Session, lastTitle?: string): Promise<void> | undefined {
    if (!s.persistConversation || s.conversationId === undefined) return
    const closed: SessionSummary = {
      id: s.id,
      provider: s.provider,
      name: nameFor(s, lastTitle),
      state: 'idle',
      startedAt: s.startedAt,
      conversationId: s.conversationId,
    }
    return changePast((rows) => [closed, ...rows.filter((p) => p.id !== s.id)].slice(0, PAST_MAX))
  }

  function retire(s: Session): void {
    push(s)
    sessions.delete(s.id)
  }

  function configure(provider: AgentProvider): Promise<{ dir: string } | null> {
    let pending = configured.get(provider.id)
    if (pending === undefined) {
      pending = provider.configure(deps.vault).catch((err: unknown) => {
        log(`${provider.id} unconfigured: ${String(err)}`)
        configured.delete(provider.id)
        return null
      })
      configured.set(provider.id, pending)
    }
    return pending
  }

  const gone = { ok: false as const, message: 'That session has ended.' }

  type StartArgs = Parameters<PtySessions['start']>[1]

  function track(start: Promise<StartResult>): Promise<StartResult> {
    starting.add(start)
    void start.then(
      () => starting.delete(start),
      () => starting.delete(start),
    )
    return start
  }

  async function startNow(
    providerId: ProviderId,
    {
      login,
      name,
      prompt,
      resume,
      fence,
      cols,
      rows,
      sessionId,
      fork,
      onStartupCleanup,
    }: StartArgs,
  ): Promise<StartResult> {
    if (left) return { ok: false, message: 'That vault has been left.' }
    const provider = deps.providers().find((p) => p.id === providerId)
    if (provider === undefined) {
      return {
        ok: false,
        message: `${providerId} is not an agent on this machine. Choose one in Settings, General, Agents.`,
      }
    }
    const refused =
      provider.refuses?.({
        ...(prompt === undefined ? {} : { prompt }),
        ...(resume === undefined ? {} : { resume }),
      }) ?? null
    if (refused !== null) return { ok: false, message: refused }
    // Its supervisor runs a background provider's sessions; only the
    // terminal that signs it in is Holi's.
    const signIn = login === true
    if (hasBackground(provider) !== signIn) {
      return {
        ok: false,
        message: signIn
          ? `${provider.label} signs in inside its sessions.`
          : `${provider.label} sessions run in the background, not here.`,
      }
    }
    const config = await configure(provider)
    if (left) return { ok: false, message: 'That vault has been left.' }
    if (config === null) {
      return { ok: false, message: `${provider.label} could not be set up for this vault.` }
    }
    if (fence !== undefined && provider.capabilities.fenced === undefined) {
      return { ok: false, message: `${provider.label} cannot run fenced to a folder.` }
    }
    if (resume !== undefined && resume !== 'pick' && !CONVERSATION_ID.test(resume)) {
      return { ok: false, message: 'That is not a valid conversation id.' }
    }
    if (fork !== undefined && !CONVERSATION_ID.test(fork)) {
      return { ok: false, message: 'That is not a valid conversation id.' }
    }
    if (sessionId !== undefined && !PTY_SESSION_ID.test(sessionId)) {
      return { ok: false, message: 'That is not a valid Holi session id.' }
    }
    const id = sessionId ?? `p${randomBytes(6).toString('hex')}`
    if (sessions.has(id) || finishedFences.has(id))
      return { ok: false, message: 'That session is already open.' }
    const owner: Finalization = { pending: new Set(), failures: new Set() }
    const conversationId =
      resume !== undefined && resume !== 'pick'
        ? resume
        : provider.namesConversation === true && (fork !== undefined || resume === undefined)
          ? randomUUID()
          : undefined
    const target = {
      root: deps.vault.root,
      configDir: config.dir,
      // Holi's commands reach the vault: a fenced session has none.
      binDir: fence === undefined ? deps.binDir() : null,
    }
    // Filled in once the terminal exists; its callbacks only run after.
    let session: Session | null = null
    const signals = createTurnSignals({
      ...(deps.idleMs === undefined ? {} : { idleMs: deps.idleMs }),
      onBegin: () => {
        if (session !== null) {
          session.copy = undefined
          session.copying = false
        }
        runBracket(owner, id, 'begin')
        push()
      },
      onEnd: () => {
        if (session?.draining) return
        const close = (): void => {
          runBracket(owner, id, 'end')
          push()
        }
        // What a fenced turn wrote is in the vault before its turn closes.
        if (fence === undefined) close()
        else {
          if (session !== null) session.copying = true
          let copyWork: Promise<FenceCopy>
          try {
            copyWork = Promise.resolve(fence.turnEnded())
          } catch (err) {
            copyWork = Promise.reject(err)
          }
          const completion = copyWork
            .then(
              (copy) => {
                if (session !== null && !session.draining) session.copy = copy
              },
              (err: unknown) => {
                owner.failures.add(err)
                if (session !== null && !session.draining) session.copy = { error: String(err) }
              },
            )
            .finally(() => {
              if (session !== null && !session.draining) session.copying = false
              close()
            })
          void trackFinalizer(owner, completion)
          push()
        }
      },
      onAttention: () => {
        if (session === null || !signals.inTurn) return
        session.attention = true
        push()
      },
    })
    let command: ReturnType<AgentProvider['terminal']>
    try {
      command = provider.terminal(target, {
        session: id,
        ...(signIn ? { login: true } : {}),
        ...(fence === undefined ? {} : { fence: { dir: fence.dir, state: fence.state } }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(resume === undefined ? {} : { resume }),
        ...(fork === undefined ? {} : { fork }),
        ...(conversationId === undefined ? {} : { conversation: conversationId }),
      })
    } catch (err) {
      signals.dispose()
      return { ok: false, message: (err as Error).message }
    }
    const notice = await firstSpawnNotice(provider, config.dir)
    if (left) {
      signals.dispose()
      return { ok: false, message: 'That vault has been left.' }
    }
    if (sessions.has(id) || finishedFences.has(id)) {
      signals.dispose()
      return { ok: false, message: 'That session is already open.' }
    }
    if (fence?.canLaunch?.() === false) {
      signals.dispose()
      return { ok: false, message: 'Fenced launch admission closed.' }
    }
    const opened = deps.terminals.open({
      remote: deps.vault.remote,
      cwd: fence?.dir ?? deps.vault.root,
      command,
      notInstalled: provider.notInstalled,
      attach: id,
      retainOnExit: provider.id === 'pi',
      ...(cols === undefined ? {} : { cols }),
      ...(rows === undefined ? {} : { rows }),
      ...(notice === undefined ? {} : { notice }),
      ...(onStartupCleanup === undefined ? {} : { onStartupCleanup }),
      onDraining: () => {
        if (session !== null) fenceAdmission(session)
      },
      onInput: (data) => {
        // A sign-in's turns are Claude Code's own: nothing typed is read.
        if (signIn) return
        const s = session
        if (s === null || s.draining) return
        // Anything typed answers what was asked, and the turn goes on.
        if (s.attention) {
          s.attention = false
          s.signals.begin()
          push()
        }
        s.signals.input(data)
      },
      onOutput: (data) => {
        if (!signIn) session?.signals.output(data)
      },
      onExit: (lastTitle, signal) => {
        const s = session
        if (s === null || sessions.get(id) !== s) return
        if (s.exitWork !== undefined) return s.exitWork
        fenceAdmission(s)
        const forget = () => {
          if (!s.forgetTurn) return
          s.forgetTurn = false
          runBracket(owner, id, 'forget')
        }
        const finish = async () => {
          if (s.provider === 'pi' && fence === undefined) {
            forget()
            if (s.name === null && lastTitle !== undefined) s.name = nameOf(lastTitle)
            s.attention = false
            push()
            await joinFinalizers(owner)
            assertFinalized(owner)
            return
          }
          if (fence === undefined) {
            forget()
            await joinFinalizers(owner)
            assertFinalized(owner)
            signal?.throwIfAborted()
            await saveClosed(s, lastTitle)
            signal?.throwIfAborted()
            retire(s)
            return
          }

          s.copying = true
          push()
          let copy: FenceCopy
          try {
            // Already admitted turn copies keep their original owner. A new
            // final copy is admitted only at this physical + output edge.
            if (owner.pending.size > 0) await joinFinalizers(owner)
            signal?.throwIfAborted()
            copy = await fence.exited(signal)
            signal?.throwIfAborted()
            forget()
            await joinFinalizers(owner)
            assertFinalized(owner)
          } catch (error) {
            signal?.throwIfAborted()
            forget()
            await joinFinalizers(owner)
            signal?.throwIfAborted()
            finishedFences.set(id, { row: fenceRow({ error: String(error) }) })
            // Presentation cannot replace the original finalization failure.
            try {
              push()
            } catch (presentationError) {
              throw new AggregateError([error, presentationError], 'PTY finalization failed.', {
                cause: error,
              })
            }
            throw error
          }
          signal?.throwIfAborted()
          const timer =
            copy.error === undefined && copy.leftOut === undefined
              ? setTimeout(() => {
                  finishedFences.delete(id)
                  push()
                }, FENCED_RESULT_MS)
              : undefined
          finishedFences.set(id, { row: fenceRow(copy), timer })
          retire(s)
        }
        const fenceRow = (copy: FenceCopy): SessionSummary => ({
          id,
          provider: s.provider,
          name: nameFor(s, lastTitle),
          state: 'idle',
          startedAt: s.startedAt,
          closed: true,
          outcome: copy.error === undefined ? 'completed' : 'failed',
          ...(copy.error === undefined ? {} : { error: copy.error }),
          ...(copy.leftOut === undefined ? {} : { message: copy.leftOut }),
        })
        const work = finish()
        s.exitWork = work
        void work.catch(() => {})
        return work
      },
    })
    if (!opened.ok) {
      signals.dispose()
      return opened
    }
    session = {
      finalization: owner,
      id,
      provider: provider.id,
      name:
        (name === undefined ? null : nameOf(name)) ??
        (prompt === undefined ? null : nameOf(prompt)),
      startedAt: Date.now(),
      terminalId: opened.id,
      ...(conversationId === undefined ? {} : { conversationId }),
      signIn,
      // A fenced session's conversation ran in a scratch folder: reopened
      // from history it would run on the vault itself, unfenced.
      persistConversation: resume !== 'pick' && fence === undefined,
      attention: false,
      signals,
    }
    sessions.set(id, session)
    // A session started on a prompt is in its first turn already.
    if (prompt !== undefined && prompt.trim() !== '') signals.begin()
    push()
    return { ok: true, sessionId: id, terminalId: opened.id }
  }

  function closeSession(s: Session): Promise<void> {
    fenceAdmission(s)
    return (s.closeWork ??= (async () => {
      await deps.terminals.close(s.terminalId)
      // Exited Pi transcripts stay open until explicit close. This phase
      // owns only session persistence, after terminal proof and callbacks.
      await bounded(
        (async () => {
          await s.exitWork
          if (sessions.get(s.id) !== s) return
          await joinFinalizers(s.finalization)
          assertFinalized(s.finalization)
          await saveClosed(s)
        })(),
        'PTY session finalization',
      )
      if (sessions.get(s.id) === s) retire(s)
    })())
  }

  const api: PtySessions = {
    sessions: () => summaries(),
    async past() {
      await bounded(
        pastQueue.then(() => undefined),
        'PTY history persistence',
      )
      const open = new Set(sessions.keys())
      const rows = await bounded(pastStore.read(), 'PTY history read')
      return rows.filter((p) => !open.has(p.id))
    },
    async hasPast(id) {
      return (await api.past()).some((p) => p.id === id)
    },
    async reopen(id, size) {
      if (left) return { ok: false, message: 'That vault has been left.' }
      if (sessions.has(id) || reopening.has(id)) {
        return { ok: false, message: 'That session is open already.' }
      }
      reopening.add(id)
      try {
        const past = (await api.past()).find((p) => p.id === id)
        if (!past || typeof past.conversationId !== 'string') {
          return { ok: false, message: 'That session cannot be reopened.' }
        }
        const result = await api.start(past.provider, {
          ...size,
          name: past.name,
          resume: past.conversationId,
          sessionId: past.id,
        })
        // A process can exit before start() returns. Its onExit has already
        // queued the closed row; do not remove that newer history entry.
        if (result.ok && sessions.has(id)) {
          await bounded(
            changePast((rows) => rows.filter((p) => p.id !== id)),
            'PTY history persistence',
          )
        }
        return result
      } finally {
        reopening.delete(id)
      }
    },
    async duplicate(id, size) {
      const source = sessions.get(id)
      const providerId = source?.provider
      const conversation = source?.conversationId
      if (!providerId || !conversation)
        return { ok: false, message: 'That session cannot be duplicated.' }
      const provider = deps.providers().find((p) => p.id === providerId)
      if (!provider?.namesConversation)
        return { ok: false, message: `${provider?.label ?? providerId} cannot be copied.` }
      return api.start(providerId, {
        ...size,
        name: source === undefined ? NEW_SESSION : nameFor(source),
        fork: conversation,
      })
    },
    has: (id) => sessions.has(id),
    ownsTerminal: (terminalId) => [...sessions.values()].some((s) => s.terminalId === terminalId),
    terminalOf: (id) => sessions.get(id)?.terminalId ?? null,

    start(providerId, args) {
      if (left) return Promise.resolve({ ok: false, message: 'That vault has been left.' })
      if (args.login !== true) return track(startNow(providerId, args))
      // One sign-in at a time: a second ask gets the terminal of the first,
      // the one still starting included.
      const running = [...sessions.values()].find((s) => s.signIn && s.provider === providerId)
      if (running !== undefined) {
        return Promise.resolve({ ok: true, sessionId: running.id, terminalId: running.terminalId })
      }
      let pending = signingIn.get(providerId)
      if (pending === undefined) {
        pending = track(startNow(providerId, args)).finally(() => signingIn.delete(providerId))
        signingIn.set(providerId, pending)
      }
      return pending
    },

    send(id, text) {
      const s = sessions.get(id)
      if (s === undefined || s.draining || !deps.terminals.paste(s.terminalId, text)) return gone
      return { ok: true, terminalId: s.terminalId }
    },

    async stop(id) {
      const s = sessions.get(id)
      if (s === undefined) return gone
      await closeSession(s)
      return { ok: true }
    },

    noteTurn(id, active) {
      const s = sessions.get(id)
      if (s === undefined || s.draining) return
      if (active) s.signals.begin()
      else {
        // A turn that ended is not waiting on anyone.
        s.attention = false
        s.signals.end()
      }
      push()
    },

    noteConversation(id, about) {
      const s = sessions.get(id)
      if (s === undefined) return
      if (s.name === null && about.name !== undefined) s.name = nameOf(about.name)
      if (about.conversationId !== undefined && CONVERSATION_ID.test(about.conversationId))
        s.conversationId = about.conversationId
      push()
    },

    noteStatus(id, status) {
      const s = sessions.get(id)
      if (s === undefined) return
      if (status.contextPercent !== undefined) s.contextPercent = status.contextPercent
      if (status.model !== undefined) s.model = status.model
      push()
    },

    providerOf: (id) => sessions.get(id)?.provider ?? null,

    async leave() {
      left = true
      // Includes sign-in starts, which also have a provider deduplication key.
      // Each terminal owns its physical, output and finalization deadlines.
      const results = await Promise.allSettled([
        bounded(Promise.all([...starting]), 'PTY session starts'),
        ...[...sessions.values()].map(closeSession),
      ])
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      try {
        await retryPastFailures()
      } catch (err) {
        errors.push(err)
      }
      if (errors.length > 0) throw new AggregateError(errors, 'PTY sessions did not drain.')
      for (const { timer } of finishedFences.values()) if (timer) clearTimeout(timer)
      finishedFences.clear()
      push()
    },
  }
  return api
}
