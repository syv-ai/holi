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
 * One per vault activation: the agent starts in a vault, and these sessions
 * end when it stops there.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { SessionState, SessionSummary } from '../claude/listing'
import { isProviderId, type AgentProvider, type ProviderId, type VaultRef } from '../provider'
import { createTurnSignals, type TurnSignals } from './pty-signals'
import type { ActionResult, Geometry, OpenResult, StartResult } from './sessions'
import type { AgentTerminals } from './terminals'

/** Holi's id for a session it runs: never a conversation id or job id. */
export const PTY_SESSION_ID = /^p[0-9a-f]{12}$/
/** @public */
export const CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAST_MAX = 50

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
  providers: readonly AgentProvider[]
  terminals: Pick<AgentTerminals, 'open' | 'close' | 'paste' | 'list'>
  /** The vault's turn bracket: sync pauses and the turn is recorded. */
  bracket(id: string, edge: 'begin' | 'end' | 'forget'): void
  /** Holi's generated commands, first on every session's `PATH`. */
  binDir(): string | null
  /** The list changed. */
  onChange(list: SessionSummary[]): void
  /** Per-vault local history store, kept outside the synced clone. */
  past?: PastStore
  onPast?(list: SessionSummary[]): void
  idleMs?: number
  log?: (msg: string) => void
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
  /** A new session of `provider`: its first message `prompt`, or a
   *  conversation to pick up (`resume`). */
  start(
    provider: ProviderId,
    args: Geometry & {
      name?: string
      prompt?: string
      resume?: string
      sessionId?: string
      fork?: string
    },
  ): Promise<StartResult>
  /** Put text in a session's input, unsent. */
  send(id: string, text: string): OpenResult
  stop(id: string): Promise<ActionResult>
  /** A turn edge from the provider's hook. */
  noteTurn(id: string, active: boolean): void
  /** What the session's hook said about it. */
  noteConversation(id: string, about: { name?: string; conversationId?: string }): void
  /** End every session. */
  leave(): Promise<void>
}

interface Session {
  id: string
  provider: ProviderId
  name: string | null
  startedAt: number
  terminalId: string
  conversationId?: string
  persistConversation: boolean
  /** A notification asked for the person, and nothing was typed since. */
  attention: boolean
  signals: TurnSignals
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
  const changePast = (change: (rows: SessionSummary[]) => SessionSummary[]): Promise<void> => {
    const next = pastQueue.then(async () => {
      const rows = change(await pastStore.read())
      await pastStore.write(rows)
      deps.onPast?.(rows)
    })
    pastQueue = next.catch((err: unknown) => log(`closed sessions: ${String(err)}`))
    return pastQueue as Promise<void>
  }
  const reopening = new Set<string>()
  const configured = new Map<ProviderId, Promise<{ dir: string } | null>>()
  let lastPushed = ''

  const stateOf = (s: Session): SessionState =>
    s.attention ? 'needs-you' : s.signals.inTurn ? 'working' : 'idle'

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

  const summaries = (): SessionSummary[] =>
    [...sessions.values()].map((s) => ({
      id: s.id,
      provider: s.provider,
      name: nameFor(s),
      state: stateOf(s),
      ...(s.attention ? { waitingFor: 'an answer' } : {}),
      startedAt: s.startedAt,
      ...(s.conversationId === undefined ? {} : { conversationId: s.conversationId }),
    }))

  function push(): void {
    const next = summaries()
    const encoded = JSON.stringify(next)
    if (encoded === lastPushed) return
    lastPushed = encoded
    deps.onChange(next)
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

  const api: PtySessions = {
    sessions: summaries,
    async past() {
      await pastQueue
      const open = new Set(sessions.keys())
      return (await pastStore.read()).filter((p) => !open.has(p.id))
    },
    async hasPast(id) {
      return (await api.past()).some((p) => p.id === id)
    },
    async reopen(id, size) {
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
          await changePast((rows) => rows.filter((p) => p.id !== id))
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
      const provider = deps.providers.find((p) => p.id === providerId)
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

    async start(providerId, { name, prompt, resume, cols, rows, sessionId, fork }) {
      const provider = deps.providers.find((p) => p.id === providerId)
      if (provider === undefined) {
        return { ok: false, message: `${providerId} is not an agent Holi knows.` }
      }
      const config = await configure(provider)
      if (config === null) {
        return { ok: false, message: `${provider.label} could not be set up for this vault.` }
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
      if (sessions.has(id)) return { ok: false, message: 'That session is already open.' }
      const conversationId =
        resume !== undefined && resume !== 'pick'
          ? resume
          : provider.namesConversation === true && (fork !== undefined || resume === undefined)
            ? randomUUID()
            : undefined
      const target = { root: deps.vault.root, configDir: config.dir, binDir: deps.binDir() }
      // Filled in once the terminal exists; its callbacks only run after.
      let session: Session | null = null
      const signals = createTurnSignals({
        ...(deps.idleMs === undefined ? {} : { idleMs: deps.idleMs }),
        onBegin: () => {
          deps.bracket(id, 'begin')
          push()
        },
        onEnd: () => {
          deps.bracket(id, 'end')
          push()
        },
        onAttention: () => {
          if (session === null || !signals.inTurn) return
          session.attention = true
          push()
        },
      })
      const opened = deps.terminals.open({
        remote: deps.vault.remote,
        cwd: deps.vault.root,
        command: provider.terminal(target, {
          session: id,
          ...(prompt === undefined ? {} : { prompt }),
          ...(resume === undefined ? {} : { resume }),
          ...(fork === undefined ? {} : { fork }),
          ...(conversationId === undefined ? {} : { conversation: conversationId }),
        }),
        notInstalled: provider.notInstalled,
        attach: id,
        ...(cols === undefined ? {} : { cols }),
        ...(rows === undefined ? {} : { rows }),
        onInput: (data) => {
          const s = session
          if (s === null) return
          // Anything typed answers what was asked, and the turn goes on.
          if (s.attention) {
            s.attention = false
            s.signals.begin()
            push()
          }
          s.signals.input(data)
        },
        onOutput: (data) => session?.signals.output(data),
        onExit: (lastTitle) => {
          const s = session
          if (s === null || sessions.get(id) !== s) return
          if (s.signals.inTurn) deps.bracket(id, 'forget')
          s.signals.dispose()
          sessions.delete(id)
          push()
          if (s.persistConversation && s.conversationId !== undefined) {
            const closed: SessionSummary = {
              id: s.id,
              provider: s.provider,
              name: nameFor(s, lastTitle),
              state: 'idle',
              startedAt: s.startedAt,
              conversationId: s.conversationId,
            }
            void changePast((rows) =>
              [closed, ...rows.filter((p) => p.id !== s.id)].slice(0, PAST_MAX),
            )
          }
        },
      })
      if (!opened.ok) {
        signals.dispose()
        return opened
      }
      session = {
        id,
        provider: provider.id,
        name:
          (name === undefined ? null : nameOf(name)) ??
          (prompt === undefined ? null : nameOf(prompt)),
        startedAt: Date.now(),
        terminalId: opened.id,
        ...(conversationId === undefined ? {} : { conversationId }),
        persistConversation: resume !== 'pick',
        attention: false,
        signals,
      }
      sessions.set(id, session)
      // A session started on a prompt is in its first turn already.
      if (prompt !== undefined && prompt.trim() !== '') signals.begin()
      push()
      return { ok: true, sessionId: id, terminalId: opened.id }
    },

    send(id, text) {
      const s = sessions.get(id)
      if (s === undefined || !deps.terminals.paste(s.terminalId, text)) return gone
      return { ok: true, terminalId: s.terminalId }
    },

    async stop(id) {
      const s = sessions.get(id)
      if (s === undefined) return gone
      await deps.terminals.close(s.terminalId)
      return { ok: true }
    },

    noteTurn(id, active) {
      const s = sessions.get(id)
      if (s === undefined) return
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

    async leave() {
      await Promise.all([...sessions.values()].map((s) => deps.terminals.close(s.terminalId)))
      await pastQueue
      for (const s of sessions.values()) s.signals.dispose()
      sessions.clear()
      push()
    },
  }
  return api
}
