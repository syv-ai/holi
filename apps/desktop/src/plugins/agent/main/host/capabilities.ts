/**
 * The agent's capabilities (docs/features/agent-sessions.md).
 *
 * **Sessions** are of two kinds, one list (docs/features/agent-sessions.md,
 * Providers): Claude Code's background sessions, named by their job id, and
 * the sessions Holi runs itself for a provider with no supervisor
 * (`pty-sessions.ts`), named by Holi's id. Each verb goes to the kind the id
 * names; one a kind cannot do is refused in words. **Terminals** are Holi's
 * PTYs, named by a terminal id: listed, attached, detached. Every verb acts in the open vault, and one asked about any other
 * vault is refused. What changes is pushed as the agent's events
 * (`sessions`, `terminals`, `pty-data`, `pty-exit`), and keystrokes and
 * resizes come back as events too, because they must keep their order.
 *
 * **Turns** are what the agent's last turns changed: a commit range each, so
 * the file list is asked of git every time rather than stored. A revert is a
 * write and a new commit, never a rewrite, the same rule history's restore
 * follows (docs/features/history.md).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { vaultRelPath, type VaultRelPath } from '@holi/shared'
import {
  cap,
  CapabilityError,
  noParams,
  optionalStringParam,
  paramsObject,
  removeDocFile,
  stringParam,
  writeAtomic,
  type CapabilityContext,
  type RangeFile,
} from '../../../../main/plugin-api'
import type { ActionResult, AgentSessions, Geometry, OpenResult, StartResult } from './sessions'
import type { AgentTerminals, TerminalSummary } from './terminals'
import type { SessionSummary } from '../claude/listing'
import { hasBackground, isProviderId, type AgentProvider, type ProviderId } from '../provider'
import { openTurnLog, type TurnRecord } from './turn-log'
import type { PtySessions } from './pty-sessions'

/** One of the agents a session can run, as the new-session menu lists it. */
export interface ProviderSummary {
  id: ProviderId
  label: string
  /** Its CLI is on this machine. */
  installed: boolean
  /** Its sessions can run with nobody watching (Holis, automations). */
  background: boolean
}

export const AGENT_NAMESPACES = ['agent'] as const

export interface AgentCapabilitiesDeps {
  /** The sessions of the open vault. */
  sessions: Pick<
    AgentSessions,
    | 'ensure'
    | 'sessions'
    | 'past'
    | 'open'
    | 'start'
    | 'launch'
    | 'watched'
    | 'send'
    | 'stop'
    | 'respawn'
    | 'duplicate'
  >
  /** The sessions Holi runs itself. */
  own: Pick<
    PtySessions,
    'sessions' | 'has' | 'ownsTerminal' | 'terminalOf' | 'start' | 'send' | 'stop'
  >
  /** Every provider, the background one first. */
  providers: readonly AgentProvider[]
  terminals: Pick<AgentTerminals, 'list' | 'attach' | 'close'>
  /** The open vault's remote, or null with none open. */
  liveRemote(): string | null
  /** Commit the open vault now. */
  commitNow(): Promise<unknown>
}

const notOpen = { ok: false as const, message: 'That vault is not open.' }

/** An optional whole number, such as a terminal's columns. */
function countParam(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new CapabilityError('BAD_REQUEST', `${key} must be a positive integer`)
  }
  return value
}

/** The size to open a terminal at, as the renderer last measured one. */
function geometry(raw: Record<string, unknown>): Geometry {
  const cols = countParam(raw, 'cols')
  const rows = countParam(raw, 'rows')
  return {
    ...(cols === undefined ? {} : { cols }),
    ...(rows === undefined ? {} : { rows }),
  }
}

/** An optional provider id. */
function providerParam(raw: Record<string, unknown>): ProviderId | undefined {
  const value = raw['provider']
  if (value === undefined || value === null) return undefined
  if (!isProviderId(value)) throw new CapabilityError('BAD_REQUEST', 'provider is not an agent Holi knows')
  return value
}

const idParams = (raw: unknown): { id: string } => ({ id: stringParam(paramsObject(raw), 'id') })

const rangeParams = (raw: unknown): { base: string; end: string } => {
  const p = paramsObject(raw)
  return { base: stringParam(p, 'base'), end: stringParam(p, 'end') }
}

/** A vault path, checked. The params keep it a plain string, as the renderer
 *  sends it; `run` brands it again. */
function relPath(path: string): VaultRelPath {
  try {
    return vaultRelPath(path)
  } catch (err) {
    throw new CapabilityError('BAD_REQUEST', (err as Error).message)
  }
}

export const agentCapabilities = (deps: AgentCapabilitiesDeps) => {
  const live = (ctx: CapabilityContext): boolean => deps.liveRemote() === ctx.remote
  /** Whether a provider's sessions are the background kind. Unknown is the
   *  background provider, which every caller before providers meant. */
  const isBackground = (id: ProviderId | undefined): boolean => {
    const p = id === undefined ? undefined : deps.providers.find((x) => x.id === id)
    return p === undefined || hasBackground(p)
  }
  const ownOnly = (verb: string) => ({
    ok: false as const,
    message: `Only a Claude Code session can be ${verb} from Holi.`,
  })

  return {
    'agent.sessions': cap({
      doors: ['ui', 'app', 'cli'],
      cli: { args: [], summary: "the vault's live agent sessions and their state" },
      params: noParams,
      run: async (ctx): Promise<SessionSummary[]> => {
        if (!live(ctx)) return []
        // Asked as the renderer mounts, and the vault may only just have
        // opened: finish attaching to it first.
        await deps.sessions.ensure()
        return [...deps.sessions.sessions(), ...deps.own.sessions()]
      },
      text: (sessions) => sessions.map((s) => `${s.state}\t${s.name}`).join('\n'),
    }),

    /** The vault's stopped background sessions, which History lists and
     *  opening brings back. */
    'agent.history': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx): Promise<SessionSummary[]> => {
        if (!live(ctx)) return []
        await deps.sessions.ensure()
        return deps.sessions.past()
      },
    }),

    /** The agents a session can run, and which are on this machine. */
    'agent.providers': cap({
      doors: ['ui'],
      params: noParams,
      run: async (): Promise<ProviderSummary[]> =>
        deps.providers.map((p) => ({
          id: p.id,
          label: p.label,
          installed: p.installed(),
          background: hasBackground(p),
        })),
    }),

    'agent.terminals': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx): Promise<TerminalSummary[]> => (live(ctx) ? deps.terminals.list() : []),
    }),

    /** A terminal on the agents list, on one session with `attach`, on a
     *  copy of a conversation (Claude Code's session id) with `fork`, or on
     *  Claude Code's `/login` for the vault with `login`. */
    'agent.open': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const attach = optionalStringParam(p, 'attach')
        const fork = optionalStringParam(p, 'fork')
        return {
          ...geometry(p),
          ...(attach === undefined ? {} : { attach }),
          ...(fork === undefined ? {} : { fork }),
          ...(p['login'] === true ? { login: true } : {}),
        }
      },
      run: async (ctx, args): Promise<OpenResult> => {
        if (!live(ctx)) return notOpen
        // A session Holi runs is its own terminal: that one, never a second.
        if (args.attach !== undefined && deps.own.has(args.attach)) {
          const terminalId = deps.own.terminalOf(args.attach)
          return terminalId === null
            ? { ok: false, message: 'That session has ended.' }
            : { ok: true, terminalId }
        }
        return deps.sessions.open(args)
      },
    }),

    /** A new session of `provider` (the background one when omitted) and
     *  its terminal. A `prompt` is its first turn; without one it waits for
     *  yours. `resume` picks up one of the provider's conversations, by its
     *  id or `pick` for the provider's own picker. */
    'agent.start': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const name = optionalStringParam(p, 'name')
        const prompt = optionalStringParam(p, 'prompt')
        const resume = optionalStringParam(p, 'resume')
        const provider = providerParam(p)
        return {
          ...geometry(p),
          ...(name === undefined ? {} : { name }),
          ...(prompt === undefined ? {} : { prompt }),
          ...(resume === undefined ? {} : { resume }),
          ...(provider === undefined ? {} : { provider }),
        }
      },
      run: async (ctx, { provider, resume, ...args }): Promise<StartResult> => {
        if (!live(ctx)) return notOpen
        if (provider !== undefined && !isBackground(provider)) {
          return deps.own.start(provider, { ...args, ...(resume === undefined ? {} : { resume }) })
        }
        return deps.sessions.start(args)
      },
    }),

    /**
     * A background session whose first turn is `prompt`, with no terminal:
     * how a plugin built on the agent runs Claude Code (a Holi's send, an
     * automation's run), from its main side through `ctx.call`, once it has
     * approved what runs. `model`, `allow` and `system` (appended to Claude
     * Code's system prompt) are that approval's. The UI door alone, never
     * the CLI's: a session could otherwise start another with rules of its
     * own choosing.
     */
    'agent.launch': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const model = optionalStringParam(p, 'model')
        const system = optionalStringParam(p, 'system')
        const allow = p['allow']
        if (
          allow !== undefined &&
          (!Array.isArray(allow) || allow.some((r) => typeof r !== 'string'))
        ) {
          throw new CapabilityError('BAD_REQUEST', 'allow must be a list of rules')
        }
        return {
          name: stringParam(p, 'name'),
          prompt: stringParam(p, 'prompt'),
          ...(model === undefined ? {} : { model }),
          ...(allow === undefined ? {} : { allow: allow as string[] }),
          ...(system === undefined ? {} : { appendSystemPrompt: system }),
        }
      },
      run: async (ctx, args) => (live(ctx) ? deps.sessions.launch(args) : notOpen),
    }),

    /** Whether Holi has a terminal open on the session: someone may be
     *  watching it, so it is not to be stopped from under them. */
    'agent.watched': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }): Promise<boolean> =>
        live(ctx) && (deps.own.has(id) || deps.sessions.watched(id)),
    }),

    /** Put text in a session's input, unsent: a live one by id, or `'new'`,
     *  a new session of `provider`. Refused, back to the sender with the text
     *  still in the box, when that session ended between being picked and
     *  being sent to. */
    'agent.send': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const provider = providerParam(p)
        return {
          ...geometry(p),
          text: stringParam(p, 'text'),
          target: stringParam(p, 'target'),
          ...(provider === undefined ? {} : { provider }),
        }
      },
      run: async (ctx, { provider, ...args }): Promise<OpenResult> => {
        if (!live(ctx)) return notOpen
        if (deps.own.has(args.target)) return deps.own.send(args.target, args.text)
        if (args.target === 'new' && provider !== undefined && !isBackground(provider)) {
          const started = await deps.own.start(provider, {
            name: args.text,
            ...(args.cols === undefined ? {} : { cols: args.cols }),
            ...(args.rows === undefined ? {} : { rows: args.rows }),
          })
          return started.ok ? deps.own.send(started.sessionId, args.text) : started
        }
        return deps.sessions.send(args)
      },
    }),

    'agent.stop': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }): Promise<ActionResult> => {
        if (!live(ctx)) return notOpen
        return deps.own.has(id) ? deps.own.stop(id) : deps.sessions.stop(id)
      },
    }),

    /** A fresh process for the same conversation (`claude respawn`). */
    'agent.respawn': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }): Promise<ActionResult> => {
        if (!live(ctx)) return notOpen
        return deps.own.has(id) ? ownOnly('restarted') : deps.sessions.respawn(id)
      },
    }),

    /** A background copy of the conversation, and a terminal on it. */
    'agent.duplicate': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return { ...geometry(p), id: stringParam(p, 'id') }
      },
      run: async (ctx, { id, ...size }): Promise<StartResult> => {
        if (!live(ctx)) return notOpen
        return deps.own.has(id) ? ownOnly('copied') : deps.sessions.duplicate(id, size)
      },
    }),

    /** A renderer is taking over a terminal: its replayable state, and its
     *  data tap opens. */
    'agent.attach': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }): Promise<string> => (live(ctx) ? deps.terminals.attach(id) : ''),
    }),

    /** Detach: ends the window, never the session. A session Holi runs is
     *  its terminal, so its stays open until the session is stopped. */
    'agent.detach': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }): Promise<null> => {
        if (live(ctx) && !deps.own.ownsTerminal(id)) await deps.terminals.close(id)
        return null
      },
    }),

    /** This machine's turn records for the vault, newest first. */
    'agent.turns': cap({
      doors: ['ui'],
      params: noParams,
      run: (ctx): Promise<TurnRecord[]> => openTurnLog(ctx.root).list(),
    }),

    /** The files one turn changed, with line counts. Empty rather than an
     *  error when the range's shas are gone: a turn record outlives the
     *  commits it names. */
    'agent.turnFiles': cap({
      doors: ['ui'],
      params: rangeParams,
      run: (ctx, { base, end }): Promise<RangeFile[]> => ctx.core.repo().rangeFiles(base, end),
    }),

    /** One file's before and after across the turn. Either side is `''` when
     *  the turn added or deleted the file, so the diff reads as a pure add or
     *  delete instead of failing. */
    'agent.turnDiff': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const path: string = relPath(stringParam(p, 'path'))
        return { ...rangeParams(p), path }
      },
      run: async (ctx, { base, end, path }): Promise<{ before: string; after: string }> => {
        const repo = ctx.core.repo()
        const rel = relPath(path)
        const before = await repo.show(base, rel).catch(() => '')
        const after = await repo.show(end, rel).catch(() => '')
        return { before, after }
      },
    }),

    /** Write the text the reviewer resolved to, and commit it; or, with
     *  `delete`, remove a file the turn created: taking a turn back leaves
     *  the vault as it was before it, not with an empty file in its place. */
    'agent.revert': cap({
      doors: ['ui'],
      writes: true,
      params: (raw): { path: string; text: string } | { path: string; delete: true } => {
        const p = paramsObject(raw)
        const path: string = relPath(stringParam(p, 'path'))
        if (p['delete'] === true) return { path, delete: true }
        const text = p['text']
        if (typeof text !== 'string') throw new CapabilityError('BAD_REQUEST', 'text is required')
        return { path, text }
      },
      run: async (ctx, args): Promise<{ ok: true }> => {
        if (!live(ctx)) throw new CapabilityError('UNAVAILABLE', 'That vault is not open.')
        if ('delete' in args) await removeDocFile(ctx.root, relPath(args.path))
        else await writeAtomic(ctx.root, relPath(args.path), args.text)
        await deps.commitNow()
        return { ok: true }
      },
    }),
  }
}
