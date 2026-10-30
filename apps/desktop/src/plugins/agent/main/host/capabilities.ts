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
 * **Jobs** (`jobs.ts`) are a third kind, for a provider that runs a prompt
 * unattended without a supervisor: named by Holi's id, with no terminal.
 *
 * **Turns** are what the agent's last turns changed: a commit range each, so
 * the file list is asked of git every time rather than stored. A revert is a
 * write and a new commit, never a rewrite, the same rule history's restore
 * follows (docs/features/history.md).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { readFile } from 'node:fs/promises'
import { merge3, vaultRelPath, type VaultRelPath } from '@holi/shared'
import {
  cap,
  CapabilityError,
  noParams,
  optionalStringParam,
  paramsObject,
  readableOrNull,
  removeDocFile,
  stringParam,
  VAULT_NOT_OPEN,
  withFileLock,
  writableFile,
  writeAtomic,
  type CapabilityContext,
  type RangeFile,
} from '../../../../main/plugin-api'
import type { ActionResult, AgentSessions, Geometry, OpenResult, StartResult } from './sessions'
import type { AgentTerminals, TerminalSummary } from './terminals'
import { JOB_ID, type SessionSummary } from '../claude/listing'
import {
  hasBackground,
  hasJobs,
  isProviderId,
  type AgentProvider,
  type ProviderId,
} from '../provider'
import type { JobResult, Jobs, JobScope } from './jobs'
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
  /** It can run a job: one prompt, unwatched, in a folder of Holi's. */
  jobs: boolean
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
    | 'message'
    | 'stop'
    | 'respawn'
    | 'duplicate'
  >
  /** The sessions Holi runs itself. */
  own: Pick<
    PtySessions,
    'sessions' | 'has' | 'ownsTerminal' | 'terminalOf' | 'start' | 'send' | 'stop'
  >
  /** The jobs Holi runs for a provider with `jobs`. */
  jobs: Pick<Jobs, 'sessions' | 'has' | 'start' | 'stop'>
  /** Every provider, the background one first. */
  providers: readonly AgentProvider[]
  terminals: Pick<AgentTerminals, 'list' | 'attach' | 'close'>
  /** The open vault's remote, or null with none open. */
  liveRemote(): string | null
  /** Commit the open vault now. */
  commitNow(): Promise<unknown>
}

const notOpen = { ok: false as const, message: VAULT_NOT_OPEN }

/** Far under Claude Code's own cap of about a million characters: a message
 *  is a note to a session, not a document. */
const MAX_MESSAGE = 100_000

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
  if (!isProviderId(value))
    throw new CapabilityError('BAD_REQUEST', 'provider is not an agent Holi knows')
  return value
}

const idParams = (raw: unknown): { id: string } => ({ id: stringParam(paramsObject(raw), 'id') })

const rangeParams = (raw: unknown): { base: string; end: string } => {
  const p = paramsObject(raw)
  return { base: stringParam(p, 'base'), end: stringParam(p, 'end') }
}

/** The most paths a job's scope names. */
const MAX_SCOPE = 50

/**
 * A job's scope: vault paths it reads, and paths or `folder/**` it writes.
 * Each must be a path a capability may read (never the agent surface, an
 * app's records, a secret or this machine's state), and a write names no
 * other wildcard.
 */
function scopeParam(raw: Record<string, unknown>): JobScope {
  const scope = raw['scope']
  if (scope === null || typeof scope !== 'object') {
    throw new CapabilityError('BAD_REQUEST', 'scope must say what the job reads and writes')
  }
  const list = (key: 'read' | 'write'): string[] => {
    const value = (scope as Record<string, unknown>)[key]
    if (
      !Array.isArray(value) ||
      value.length > MAX_SCOPE ||
      value.some((p) => typeof p !== 'string')
    ) {
      throw new CapabilityError('BAD_REQUEST', `scope.${key} must be a list of vault paths`)
    }
    return value as string[]
  }
  const checked = (path: string, glob: boolean): string => {
    const base = glob && path.endsWith('/**') ? path.slice(0, -3) : path
    const rel = base.includes('*') ? null : readableOrNull(base)
    if (rel === null) throw new CapabilityError('FORBIDDEN', path)
    return base === path ? rel : `${rel}/**`
  }
  return {
    read: list('read').map((p) => checked(p, false)),
    write: list('write').map((p) => checked(p, true)),
  }
}

/** A job's scope as Claude Code's permission rules: what a background
 *  session started for it is allowed without asking.
 * @public exported for its test
 */
export function scopeRules(scope: JobScope): string[] {
  return [
    ...scope.read.map((p) => `Read(./${p})`),
    ...scope.write.flatMap((p) => [`Read(./${p})`, `Edit(./${p})`, `Write(./${p})`]),
  ]
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
  const jobOnly = {
    ok: false as const,
    message: 'A job runs with no terminal: what it did shows where it was started.',
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
        return [...deps.sessions.sessions(), ...deps.own.sessions(), ...deps.jobs.sessions()]
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
          jobs: hasJobs(p),
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
        if (args.attach !== undefined && deps.jobs.has(args.attach)) return jobOnly
        // A session Holi runs is its own terminal: that one, never a second.
        if (args.attach !== undefined && deps.own.has(args.attach)) {
          const terminalId = deps.own.terminalOf(args.attach)
          return terminalId === null
            ? { ok: false, message: 'That session has ended.' }
            : { ok: true, terminalId }
        }
        // Anything else is a background session's job id, which reaches
        // `claude attach` as an argument: nothing else gets that far.
        if (args.attach !== undefined && !JOB_ID.test(args.attach)) {
          throw new CapabilityError('BAD_REQUEST', `not a session id: ${args.attach}`)
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

    /**
     * One prompt run with nobody watching, by `provider` (the background one
     * when omitted), touching only its `scope`: the files it reads and the
     * paths (or `folder/**`) it writes. A provider with `background` runs it
     * as a background session allowed exactly that scope; one with `jobs`
     * runs it in a folder of Holi's and copies back what it wrote
     * (`jobs.ts`). Any other is refused, never run on another agent. The UI
     * door alone, as `agent.launch`.
     */
    'agent.job': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const model = optionalStringParam(p, 'model')
        const system = optionalStringParam(p, 'system')
        const provider = providerParam(p)
        return {
          name: stringParam(p, 'name'),
          prompt: stringParam(p, 'prompt'),
          scope: scopeParam(p),
          ...(model === undefined ? {} : { model }),
          ...(system === undefined ? {} : { system }),
          ...(provider === undefined ? {} : { provider }),
        }
      },
      run: async (ctx, { provider: id, scope, system, ...args }): Promise<JobResult> => {
        if (!live(ctx)) return notOpen
        const provider =
          id === undefined ? deps.providers[0] : deps.providers.find((p) => p.id === id)
        if (provider === undefined) return { ok: false, message: 'No agent can run this.' }
        if (hasBackground(provider)) {
          return deps.sessions.launch({
            ...args,
            allow: scopeRules(scope),
            ...(system === undefined ? {} : { appendSystemPrompt: system }),
          })
        }
        if (hasJobs(provider)) {
          return deps.jobs.start({
            provider,
            ...args,
            scope,
            ...(system === undefined ? {} : { system }),
          })
        }
        return {
          ok: false,
          message: `${provider.label} cannot run a job with nobody watching.`,
        }
      },
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
        if (deps.jobs.has(args.target)) return jobOnly
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

    /**
     * Add a message to a running session's conversation through its inbox
     * socket (`claude/messaging.ts`): it starts a turn when the session is
     * idle, and is read after the tool call in flight when it is working.
     * Nothing is typed into a terminal, so a person's half-written prompt is
     * left alone. Sent once, never retried.
     */
    'agent.message': cap({
      doors: ['ui', 'cli'],
      cli: {
        args: ['session', 'text'],
        summary:
          "add a message to a running session's conversation: a turn when it is idle, read after its current step when it is working",
      },
      params: (raw) => {
        const p = paramsObject(raw)
        const session = stringParam(p, 'session')
        if (!JOB_ID.test(session) && !deps.own.has(session) && !deps.jobs.has(session)) {
          throw new CapabilityError('BAD_REQUEST', `not a session id: ${session}`)
        }
        const text = stringParam(p, 'text')
        if (text.trim() === '') throw new CapabilityError('BAD_REQUEST', 'text is empty')
        if (text.length > MAX_MESSAGE) {
          throw new CapabilityError('BAD_REQUEST', `text is over ${MAX_MESSAGE} characters`)
        }
        return { session, text }
      },
      run: async (ctx, { session, text }): Promise<{ ok: true }> => {
        if (!live(ctx)) throw new CapabilityError('UNAVAILABLE', VAULT_NOT_OPEN)
        // A session Holi runs itself has no inbox: messaging is Claude Code's
        // background capability, and typing into its terminal is not this.
        if (deps.own.has(session) || deps.jobs.has(session)) {
          throw new CapabilityError('UNAVAILABLE', 'Only a Claude Code session takes messages.')
        }
        await deps.sessions.message(session, text)
        return { ok: true }
      },
      text: () => 'sent',
    }),

    'agent.stop': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }): Promise<ActionResult> => {
        if (!live(ctx)) return notOpen
        if (deps.jobs.has(id)) return deps.jobs.stop(id)
        return deps.own.has(id) ? deps.own.stop(id) : deps.sessions.stop(id)
      },
    }),

    /** A fresh process for the same conversation (`claude respawn`). */
    'agent.respawn': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }): Promise<ActionResult> => {
        if (!live(ctx)) return notOpen
        if (deps.jobs.has(id)) return jobOnly
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
        if (deps.jobs.has(id)) return jobOnly
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

    /**
     * Write the text the reviewer resolved to, and commit it; or, with
     * `delete`, remove a file the turn created: taking a turn back leaves the
     * vault as it was before it, not with an empty file in its place.
     *
     * `base`, when given, is the text the review was built from (the file at
     * the turn's end). The file may have changed since (the person typing, a
     * teammate's pull, the agent's next turn): those changes are kept by a
     * three-way merge, and when they overlap what the reviewer kept nothing
     * is written (CONFLICT), so a revert never takes back work the review
     * never showed.
     */
    'agent.revert': cap({
      doors: ['ui'],
      writes: true,
      params: (
        raw,
      ): { path: string; text: string; base?: string } | { path: string; delete: true } => {
        const p = paramsObject(raw)
        const path: string = relPath(stringParam(p, 'path'))
        if (p['delete'] === true) return { path, delete: true }
        const { text, base } = p
        if (typeof text !== 'string') throw new CapabilityError('BAD_REQUEST', 'text is required')
        if (base !== undefined && typeof base !== 'string') {
          throw new CapabilityError('BAD_REQUEST', 'base must be the text the review showed')
        }
        return { path, text, ...(base === undefined ? {} : { base }) }
      },
      run: async (ctx, args): Promise<{ ok: true }> => {
        if (!live(ctx)) throw new CapabilityError('UNAVAILABLE', VAULT_NOT_OPEN)
        const rel = relPath(args.path)
        if ('delete' in args) {
          await removeDocFile(ctx.root, rel)
        } else {
          const { text, base } = args
          const abs = await writableFile(ctx, rel)
          await withFileLock(abs, async () => {
            // A file the turn deleted is absent on disk and empty in the review.
            const current = (await readFile(abs, 'utf8').catch(() => null)) ?? ''
            let next = text
            if (base !== undefined && current !== base) {
              const merged = merge3(base, text, current)
              if (merged.kind === 'conflict') {
                throw new CapabilityError(
                  'CONFLICT',
                  `${rel} has changed since this turn, where you are changing it. Nothing was written: open the file to see what changed.`,
                )
              }
              next = merged.text
            }
            await writeAtomic(ctx.root, rel, next)
          })
        }
        await deps.commitNow()
        return { ok: true }
      },
    }),
  }
}
