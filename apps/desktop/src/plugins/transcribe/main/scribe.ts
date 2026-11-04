/**
 * The meeting's scribe: one background session per meeting on the vault's
 * agent, started through the agent (`agent.launch`) with a brief of its own,
 * that cuts the meeting into groups. Each agent gets a scribe that can do
 * nothing else:
 *
 * - **Claude Code**: one allow rule, `Bash(holi meeting:*)`, that writes the
 *   groups through `holi meeting group` (`capabilities.ts`), and no file or
 *   web tools (`SCRIBE_DENY`).
 * - **Pi**: a run with no tools at all (`tools: 'none'`: no extensions,
 *   skills, context files or MCP either), kept for the meeting, that answers
 *   each message with the groups as JSON; main reads the answer at the turn's
 *   end (`agent.reply`) and writes them as `holi meeting group` would.
 * - Codex has neither a deny list nor a tool-less run, so a meeting on it
 *   records and captions without topics and says why (`scribeUnsupported`).
 *
 * **It is fed per group, not per minute.** A batch goes when the session is
 * idle and either at least `BATCH_TRANSCRIPT_S` of new transcript waits, or
 * the person pressed Summarise now (`summarise`), or the meeting stopped
 * (the final pass). About three minutes is how long a subject runs, so most
 * batches close a group or none, and the scribe takes a fifth of the turns
 * it took at one batch every 45 s. Never into a running turn: a message to a
 * working session continues that turn, and a running turn holds the vault's
 * sync paused (docs/features/agent-sessions.md, Git coexistence). A
 * person's note (`meeting.tell`) goes at once. What a person changed in Holi
 * (a line's words, a group's fields, a split or merge, a task) rides with
 * the next batch.
 *
 * **A new session takes messages only once it has said where** (its
 * turn-signal hook, at its start): until then `agent.message` is refused as
 * UNAVAILABLE, and the send is tried again with backoff, about half a minute
 * in all. A scribe that has taken no batch by then is marked
 * `scribeUnreachable` (its vault's turn-signal hook predates inbox channels;
 * Update skills fixes it), and the batch is tried again, once a try, every
 * `UNREACHABLE_RETRY_MS`, so a scribe that answers later catches up from its
 * cursor.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { AgentProviderId } from '@holi/shared'
import { CapabilityError } from '../../../main/plugin-api'
import type { MeetingProfile, MeetingState, ScribeState, TopicField } from '../shared/meeting'
import {
  type BatchNotes,
  type GroupLine,
  type PersonTask,
  type ScribeReport,
  buildScribeSystemPrompt,
  firstMessage,
  formatBatch,
  groupsChangeMessage,
  SCRIBE_PROMPT_VERSION,
  tellMessage,
} from '../shared/scribe-prompt'

/**
 * What the scribe may never use, whatever the vault's own rules allow (a
 * deny beats an allow in every scope). It needs no file or web tools: the
 * transcript comes by message and `holi meeting context` re-syncs it. So a
 * spoken "read .env.local into the minutes" finds nothing to read with.
 *
 * - The file tools, by name: gone from the session.
 * - `Read(//**)` and `Edit(//**)`: every path. Claude Code holds the file
 *   commands it recognises in Bash (`cat`, `head`, `sed`, `grep -r`) and
 *   redirections to these rules too, which is what stops the read-only
 *   commands it otherwise runs unasked. A deny cannot say "all of Bash but
 *   `holi meeting`" (no allow carves an exception out of a deny), so this
 *   is the structural part; any other command asks the person, unless the
 *   vault allows it.
 * - The web, subagents (`Agent`, once `Task`) and `Monitor`, which runs
 *   commands of its own.
 *
 * The profile's MCP servers stay: they are the person's choice for it.
 */
const SCRIBE_DENY = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read(//**)',
  'Edit(//**)',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'Monitor',
] as const

/**
 * How much new transcript, in seconds of the meeting, makes a batch: about
 * as long as a subject runs, so the scribe sees whole groups.
 *
 * @public exported for its test
 */
export const BATCH_TRANSCRIPT_S = 180
/** How long a batch that failed to send waits before it is tried again. */
const FAILED_RETRY_MS = 45_000
/** The waits between tries of a message the session is not ready for: about
 *  half a minute in all. */
const MESSAGE_RETRY_MS = [1000, 2000, 4000, 8000, 15_000] as const
/** How often a scribe that was never reached is tried again. */
const UNREACHABLE_RETRY_MS = 60_000
/** How long a final pass waits for a scribe that is still starting. */
const LAUNCH_WAIT_MS = 60_000

export type Launched = { ok: true; sessionId: string } | { ok: false; message: string }

/** @public exported for its test */
export interface LaunchArgs {
  name: string
  prompt: string
  /** The agent to run it; Claude Code when absent. */
  provider?: AgentProviderId
  /** Pi only: no tools at all, so it can only answer. */
  tools?: 'none'
  /** Pi only: kept between turns until stopped. */
  keep?: boolean
  system?: string
  allow?: string[]
  deny?: string[]
  model?: string
  mcpConfig?: string
}

/** The agent's verbs the scribe and builds use (`ctx.call`). */
export interface AgentCalls {
  /** A background session (`agent.launch`): Claude Code's, or Pi's run. */
  launch(args: LaunchArgs): Promise<Launched>
  /** A session in its own terminal, which the person watches
   *  (`agent.start`): for an agent with no background runs. */
  start(args: { name: string; prompt: string; provider: AgentProviderId }): Promise<Launched>
  message(session: string, text: string): Promise<unknown>
  /** What a Pi run's last turn answered (`agent.reply`). */
  reply(session: string): Promise<string | null>
  /** End a session (`agent.stop`): a kept Pi run, once its meeting is done. */
  stop(session: string): Promise<unknown>
}

/**
 * What waits to reach the scribe besides new transcript: what a person
 * changed in Holi. Kept with the meeting (`engine.ts`) and emptied as a
 * batch carrying it is delivered. A split or merge needs no note: the groups
 * it touched are stale, and every batch lists them.
 */
export interface ScribeNotes {
  /** Lines the scribe was already sent whose words a person corrected, by
   *  index. */
  corrections: Record<number, string>
  /** Tasks a person made, until the scribe hears of them. */
  tasks?: PersonTask[]
  /** Groups a person edited, by id, until the scribe hears what they say. */
  edits?: string[]
}

/** The groups as a batch lists them. For the final pass the open one is
 *  shown closed: it closes with the meeting (the engine closes it once the
 *  pass is over, so the pass may still cut it). */
function groupLines(meeting: MeetingState, final: boolean): GroupLine[] {
  return meeting.topics.map((t) => {
    const open = t.open && !final
    return {
      startIndex: t.lines[0] ?? 0,
      title: t.title,
      start: t.start,
      end: t.end,
      open,
      stale: t.stale === true || (!open && t.summary.length === 0),
      edited: t.edited ?? [],
      suggestions: t.suggestions.map(({ kind, title }) => ({ kind, title })),
    }
  })
}

/** What the edited groups' edited fields say now. */
function editsOf(meeting: MeetingState, ids: readonly string[]): NonNullable<BatchNotes['edits']> {
  return ids.flatMap((id) => {
    const t = meeting.topics.find((x) => x.id === id)
    if (t === undefined || (t.edited ?? []).length === 0) return []
    const fields: Partial<Record<TopicField, unknown>> = {}
    for (const f of t.edited ?? []) fields[f] = t[f]
    return [{ startIndex: t.lines[0] ?? 0, fields }]
  })
}

/** Whether enough new transcript waits for a batch. */
function transcriptDue(meeting: MeetingState): boolean {
  const fresh = meeting.segments.filter((s) => s.i > meeting.scribeCursor)
  const last = fresh.at(-1)
  if (last === undefined) return false
  const from = meeting.segments.find((s) => s.i === meeting.scribeCursor)?.end ?? fresh[0]!.start
  return last.end - from >= BATCH_TRANSCRIPT_S
}

/** What the scribe reads and changes of the meetings (`engine.ts`). */
export interface ScribeHost {
  /** A meeting in memory, with the profile it started with and what a
   *  person changed for the scribe to hear. */
  get(
    id: string,
  ): { meeting: MeetingState; profile: MeetingProfile; notes: ScribeNotes } | undefined
  /** The meetings in memory that are recording or finishing. */
  live(): MeetingState[]
  /** Something about the meeting changed: persist it and tell the renderer. */
  changed(id: string): void
}

/** A row of the agent's `sessions` news, as far as the scribe reads it. */
interface SessionRow {
  id: string
  state: string
  /** How its last turn ended: a Pi run's failed or aborted one ends it. */
  outcome?: string
}

/** What a person's word to the scribe is: a standing note, or a change to
 *  the groups the minutes are built from. */
export type TellKind = 'note' | 'minutes'

export interface Scribe {
  launch(meetingId: string): Promise<void>
  /** The agent's session list changed. */
  hearSessions(rows: unknown): void
  /** A session's turn ended. */
  hearTurnEnd(sessionId: string): void
  /** New transcript was stitched, or a person changed something: send a
   *  batch if one is due and the scribe is ready for it. */
  feed(meetingId: string): void
  /** The person pressed Summarise now: the next batch goes as soon as the
   *  scribe is idle, however little transcript waits. */
  summarise(meetingId: string): void
  /** A person's note, sent at once; `minutes` asks for the groups, and so
   *  the minutes, to change. Throws when it cannot be delivered. */
  tell(meetingId: string, text: string, kind?: TellKind): Promise<void>
  /** The meeting stopped and its transcript is complete: send the final
   *  pass, and resolve when the scribe's turn on it ends, or at `deadline`
   *  (epoch ms), whichever is first. A scribe still starting is waited for,
   *  within `LAUNCH_WAIT_MS`; with none, it resolves at once. */
  finish(meetingId: string, deadline: number): Promise<void>
  /** The last line the scribe has, or is being sent: a correction to one
   *  at or before it must reach the scribe as a correction. */
  through(meetingId: string): number
  /** The meeting is gone: what waits for its scribe is dropped, and a kept
   *  run (`session`) is stopped. */
  end(meetingId: string, session: string | undefined): void
  dispose(): void
}

interface Runtime {
  /** No batch is tried before this (epoch ms): after one that failed. */
  retryAt: number
  /** The person pressed Summarise now, and that batch has not gone yet. */
  now: boolean
  sending: boolean
  /** The last line of the batch on its way, while one is. */
  inflight: number | null
  timer: ReturnType<typeof setTimeout> | null
  final: {
    sent: boolean
    sawWorking: boolean
    done: () => void
  } | null
  /** How its scribe reports: commands (Claude Code) or its answer (Pi). */
  report: ScribeReport
  /** Why groups a tool-less scribe answered were not written, for its next
   *  message: it sees no command fail, as one with Bash does. */
  refused: string[]
  /** A person's words for a tool-less scribe whose turn is still running:
   *  sent into it, they would end it as one answer run into the next. */
  waiting: Array<{ text: string; sent: (ok: boolean) => void }>
}

/**
 * The groups in a tool-less scribe's answer: one JSON array, perhaps in a
 * code fence or with a word around it. Null when there is none.
 *
 * @public exported for its test
 */
export function groupsInAnswer(text: string | null): unknown[] | null {
  if (text === null) return null
  // Every top-level array, so two answers run together both count.
  const arrays: unknown[][] = []
  let depth = 0
  let start = -1
  let quoted = false
  for (let k = 0; k < text.length; k++) {
    const c = text[k]
    if (quoted) {
      if (c === '\\') k++
      else if (c === '"') quoted = false
    } else if (c === '"' && depth > 0) quoted = true
    else if (c === '[') {
      if (depth === 0) start = k
      depth++
    } else if (c === ']' && depth > 0) {
      depth--
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, k + 1))
          if (Array.isArray(parsed)) arrays.push(parsed)
        } catch {
          // Not JSON: words in brackets, say.
        }
      }
    }
  }
  return arrays.length === 0 ? null : arrays.flat()
}

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createScribe(deps: {
  agent: AgentCalls
  host: ScribeHost
  log(level: 'info' | 'warn' | 'error', message: string): void
  now?: () => number
  /** The vault's chosen agent; Claude Code when absent. */
  provider?: () => Promise<AgentProviderId>
  /** Write a group a tool-less scribe answered, as `holi meeting group`
   *  does for the session `session`. */
  group?(session: string, json: string): Promise<unknown>
}): Scribe {
  const now = deps.now ?? Date.now
  const runtimes = new Map<string, Runtime>()
  /** Each meeting's scribe launch while it is under way. */
  const launching = new Map<string, Promise<void>>()
  let disposed = false

  const rt = (id: string): Runtime => {
    let r = runtimes.get(id)
    if (r === undefined) {
      r = {
        retryAt: 0,
        now: false,
        sending: false,
        inflight: null,
        timer: null,
        final: null,
        report: 'bash',
        refused: [],
        waiting: [],
      }
      runtimes.set(id, r)
    }
    return r
  }

  const setState = (m: MeetingState, state: ScribeState): void => {
    if (m.scribeState === state) return
    m.scribeState = state
    deps.host.changed(m.id)
  }

  /** Deliver `text`, trying again while the session is not ready yet and,
   *  given `wanted`, while that still holds. `'unavailable'` when the
   *  session never became ready. */
  async function deliver(
    session: string,
    text: string,
    wanted: () => boolean = () => true,
    retries: readonly number[] = MESSAGE_RETRY_MS,
  ): Promise<true | false | 'unavailable'> {
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.agent.message(session, text)
        return true
      } catch (err) {
        const wait = retries[attempt]
        const unavailable = errorCode(err) === 'UNAVAILABLE'
        if (!unavailable || wait === undefined || disposed || !wanted()) {
          deps.log('warn', `meeting: could not message session ${session}: ${String(err)}`)
          return unavailable ? 'unavailable' : false
        }
        await sleep(wait)
        // The session may have stopped, or the meeting ended, meanwhile.
        if (disposed || !wanted()) return false
      }
    }
  }

  /** Send the meeting's scribe everything past its cursor, the groups as
   *  they stand and what the person changed; `final` makes it the final
   *  pass. True when it was delivered. */
  async function sendBatch(id: string, final = false): Promise<boolean> {
    const entry = deps.host.get(id)
    const r = rt(id)
    const session = entry?.meeting.scribeSessionId
    if (entry === undefined || session === undefined) return false
    const { meeting, notes } = entry
    const fresh = meeting.segments.filter((s) => s.i > meeting.scribeCursor)
    const last = fresh.at(-1)?.i ?? meeting.scribeCursor
    // What this batch carries of the person's changes, so a change made
    // while it is on its way waits for the next one.
    const corrections = Object.entries(notes.corrections).map(([i, text]) => ({
      i: Number(i),
      text,
    }))
    const tasks = [...(notes.tasks ?? [])]
    const edited = [...(notes.edits ?? [])]
    const edits = editsOf(meeting, edited)
    const asked = r.now
    const refused = [...r.refused]
    const batch = formatBatch(fresh, {
      groups: groupLines(meeting, final),
      notes: {
        ...(corrections.length === 0 ? {} : { corrections }),
        ...(tasks.length === 0 ? {} : { tasks }),
        ...(edits.length === 0 ? {} : { edits }),
      },
      ...(asked ? { now: true } : {}),
      ...(final ? { final: true } : {}),
      report: r.report,
    })
    const text =
      refused.length === 0
        ? batch
        : `Holi could not write some groups of your last answer; answer them again, fixed:\n${refused.map((x) => `- ${x}`).join('\n')}\n\n${batch}`
    r.sending = true
    r.inflight = last
    try {
      // Once known unreachable, one try a time: the background retry is slow.
      const sent = await deliver(
        session,
        text,
        undefined,
        meeting.scribeUnreachable === true ? [] : MESSAGE_RETRY_MS,
      )
      if (sent === true) {
        for (const c of corrections) {
          if (notes.corrections[c.i] === c.text) delete notes.corrections[c.i]
        }
        if (tasks.length > 0) {
          notes.tasks = (notes.tasks ?? []).filter((t) => !tasks.includes(t))
          if (notes.tasks.length === 0) delete notes.tasks
        }
        if (edited.length > 0) {
          notes.edits = (notes.edits ?? []).filter((t) => !edited.includes(t))
          if (notes.edits.length === 0) delete notes.edits
        }
        if (asked) r.now = false
        r.refused = r.refused.filter((x) => !refused.includes(x))
        meeting.scribeCursor = last
        reached(meeting)
        setState(meeting, 'working')
        deps.host.changed(id)
        return true
      }
      // A failed send waits before the next try, rather than hammering.
      r.retryAt = now() + FAILED_RETRY_MS
      if (sent === 'unavailable' && meeting.scribeCursor < 0 && !disposed) {
        if (meeting.scribeUnreachable !== true) {
          meeting.scribeUnreachable = true
          deps.log(
            'warn',
            `meeting "${meeting.title}": the scribe takes no messages; its vault's skills need updating`,
          )
          deps.host.changed(id)
        }
        // Tried again in the background, slowly, until it answers.
        r.retryAt = now() + UNREACHABLE_RETRY_MS
      }
      if (r.timer === null && !final) {
        r.timer = setTimeout(
          () => {
            r.timer = null
            feed(id)
          },
          Math.max(0, r.retryAt - now()),
        )
      }
      return false
    } finally {
      r.sending = false
      r.inflight = null
    }
  }

  /** The scribe took a message: it is reachable after all. */
  function reached(meeting: MeetingState): void {
    if (meeting.scribeUnreachable === undefined) return
    delete meeting.scribeUnreachable
    deps.host.changed(meeting.id)
  }

  function feed(id: string): void {
    const entry = deps.host.get(id)
    const r = rt(id)
    if (entry === undefined || disposed) return
    const { meeting } = entry
    if (meeting.phase === 'finishing') return tryFinal(id)
    if (meeting.phase !== 'recording' || r.sending || r.final !== null) return
    if (meeting.scribeState !== 'idle' || meeting.scribeSessionId === undefined) return
    if (now() < r.retryAt) return
    if (!r.now && !transcriptDue(meeting)) return
    void sendBatch(id)
  }

  /** The final pass, once the scribe is idle. */
  function tryFinal(id: string): void {
    const entry = deps.host.get(id)
    const r = runtimes.get(id)
    const final = r?.final
    if (entry === undefined || r === undefined || final == null || final.sent || r.sending) return
    const { meeting } = entry
    if (meeting.scribeState === 'gone' || meeting.scribeState === 'off') return final.done()
    if (meeting.scribeState !== 'idle') return
    final.sent = true
    void sendBatch(id, true).then((ok) => {
      if (!ok) final.done()
    })
  }

  /** The scribe of a meeting whose final pass was sent reports a state. */
  function settleFinal(id: string, state: ScribeState, turnEnded: boolean): void {
    const final = runtimes.get(id)?.final
    if (final == null || !final.sent) return
    if (state === 'working') final.sawWorking = true
    if (turnEnded || state === 'gone' || (final.sawWorking && state === 'idle')) final.done()
  }

  /** What starts the scribe on `provider`, or null for an agent that has no
   *  way to hold it to the meeting. */
  function launchArgs(
    provider: AgentProviderId,
    meeting: MeetingState,
    profile: MeetingProfile,
  ): LaunchArgs | null {
    const name = `Meeting · ${meeting.title}`
    if (provider === 'claude') {
      return {
        name,
        system: buildScribeSystemPrompt(profile, meeting),
        prompt: firstMessage(),
        allow: ['Bash(holi meeting:*)'],
        deny: [...SCRIBE_DENY],
        ...(profile.scribeModel === undefined ? {} : { model: profile.scribeModel }),
        ...(profile.mcpConfig === undefined ? {} : { mcpConfig: profile.mcpConfig }),
      }
    }
    // The profile's model and MCP servers are Claude Code's: Pi's run uses
    // its own default model, and has no tools for a server to add to.
    if (provider === 'pi') {
      return {
        name,
        provider: 'pi',
        tools: 'none',
        keep: true,
        system: buildScribeSystemPrompt(profile, meeting, 'reply'),
        prompt: firstMessage('reply'),
      }
    }
    return null
  }

  /** Start the meeting's scribe on the vault's agent, in the form that holds
   *  it to the meeting there (above); on an agent with none, the meeting
   *  records and captions without topics and says why
   *  (`scribeUnsupported`), never on Claude behind the person's choice. */
  async function launch(id: string): Promise<void> {
    const entry = deps.host.get(id)
    if (entry === undefined) return
    const { meeting, profile } = entry
    setState(meeting, 'starting')
    const provider = (await deps.provider?.().catch(() => 'claude' as const)) ?? 'claude'
    const args = launchArgs(provider, meeting, profile)
    if (args === null) {
      meeting.scribeUnsupported = provider
      deps.log('info', `meeting "${meeting.title}": no scribe, ${provider} cannot run it`)
      setState(meeting, 'off')
      return
    }
    delete meeting.scribeUnsupported
    rt(id).report = args.tools === 'none' ? 'reply' : 'bash'
    let res: Launched
    try {
      res = await deps.agent.launch(args)
    } catch (err) {
      res = { ok: false, message: String(err) }
    }
    if (!res.ok) {
      deps.log('error', `meeting "${meeting.title}": the scribe did not start: ${res.message}`)
      setState(meeting, 'gone')
      return
    }
    meeting.scribeSessionId = res.sessionId
    deps.host.changed(id)
    deps.log(
      'info',
      `meeting "${meeting.title}": scribe ${res.sessionId} started (prompt ${SCRIBE_PROMPT_VERSION})`,
    )
  }

  /** Write the groups a tool-less scribe answered with. */
  async function answered(session: string, meeting: MeetingState): Promise<void> {
    const text = await deps.agent.reply(session).catch(() => null)
    const groups = groupsInAnswer(text)
    if (groups === null) {
      if (text !== null && text.trim() !== '' && text.trim().toLowerCase() !== 'ok') {
        deps.log('warn', `meeting "${meeting.title}": the scribe answered without groups`)
      }
      return
    }
    for (const group of groups) {
      try {
        await deps.group?.(session, JSON.stringify(group))
      } catch (err) {
        const at = (group as { startIndex?: unknown } | null)?.startIndex
        const why = err instanceof Error ? err.message : String(err)
        rt(meeting.id).refused.push(`[${typeof at === 'number' ? at : '?'}] ${why}`)
        deps.log('warn', `meeting "${meeting.title}": a group the scribe wrote: ${why}`)
      }
    }
  }

  const scribed = (sessionId: string): MeetingState | undefined =>
    deps.host.live().find((m) => m.scribeSessionId === sessionId)

  return {
    launch(id) {
      const run = launch(id).finally(() => launching.delete(id))
      launching.set(id, run)
      return run
    },

    hearSessions(rows) {
      if (!Array.isArray(rows)) return
      const list = rows as SessionRow[]
      for (const meeting of deps.host.live()) {
        const session = meeting.scribeSessionId
        if (session === undefined) continue
        const row = list.find((r) => r?.id === session)
        const state: ScribeState =
          row === undefined || row.outcome === 'failed' || row.outcome === 'aborted'
            ? 'gone'
            : row.state === 'working' || row.state === 'idle' || row.state === 'needs-you'
              ? row.state
              : meeting.scribeState
        // A tool-less scribe's turn is over once its answer is written, at
        // the turn's end (`hearTurnEnd`), not when its run goes idle.
        if (
          state === 'idle' &&
          rt(meeting.id).report === 'reply' &&
          meeting.scribeState === 'working'
        ) {
          continue
        }
        setState(meeting, state)
        settleFinal(meeting.id, state, false)
        if (state === 'idle' || state === 'gone') feed(meeting.id)
      }
    },

    hearTurnEnd(sessionId) {
      const meeting = scribed(sessionId)
      if (meeting === undefined) return
      const ended = () => {
        setState(meeting, 'idle')
        settleFinal(meeting.id, 'idle', true)
        feed(meeting.id)
      }
      const r = rt(meeting.id)
      if (r.report === 'bash') return ended()
      // A tool-less scribe's groups are its answer: written before the turn
      // counts as over, so the final pass ends with them in. A person's word
      // that waited for the turn goes next, before any batch.
      void answered(sessionId, meeting).finally(() => {
        const next = r.waiting.shift()
        if (next === undefined) return ended()
        void deliver(sessionId, next.text).then((ok) => {
          next.sent(ok === true)
          if (ok !== true) ended()
        })
      })
    },

    feed,

    summarise(id) {
      rt(id).now = true
      feed(id)
    },

    async tell(id, text, kind = 'note') {
      const meeting = deps.host.get(id)?.meeting
      const session = meeting?.scribeSessionId
      if (meeting === undefined || session === undefined || meeting.scribeState === 'gone') {
        throw new CapabilityError('UNAVAILABLE', 'this meeting has no scribe running')
      }
      const r = rt(id)
      const report = r.report
      const message =
        kind === 'minutes' ? groupsChangeMessage(text, report) : tellMessage(text, report)
      if (report === 'reply' && (meeting.scribeState === 'working' || r.sending)) {
        // Into a running turn it would join that turn's answer: it waits.
        if (!(await new Promise<boolean>((sent) => r.waiting.push({ text: message, sent })))) {
          throw new CapabilityError('UNAVAILABLE', 'the scribe did not take the message')
        }
        reached(meeting)
        setState(meeting, 'working')
        return
      }
      if ((await deliver(session, message)) !== true) {
        throw new CapabilityError('UNAVAILABLE', 'the scribe did not take the message')
      }
      reached(meeting)
      setState(meeting, 'working')
    },

    through(id) {
      const cursor = deps.host.get(id)?.meeting.scribeCursor ?? -1
      return Math.max(cursor, runtimes.get(id)?.inflight ?? -1)
    },

    async finish(id, deadline) {
      const pending = launching.get(id)
      if (pending !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const wait = Math.min(LAUNCH_WAIT_MS, Math.max(0, deadline - now()))
        await Promise.race([
          pending,
          new Promise<void>((resolve) => (timer = setTimeout(resolve, wait))),
        ])
        clearTimeout(timer)
      }
      const meeting = deps.host.get(id)?.meeting
      if (
        meeting === undefined ||
        meeting.scribeSessionId === undefined ||
        meeting.scribeState === 'gone' ||
        meeting.scribeState === 'off'
      ) {
        return Promise.resolve()
      }
      const r = rt(id)
      const session = meeting.scribeSessionId
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => done(), Math.max(0, deadline - now()))
        const done = () => {
          clearTimeout(timer)
          if (r.final !== null) r.final = null
          resolve()
        }
        r.final = { sent: false, sawWorking: false, done }
        tryFinal(id)
      })
      // A kept run is the meeting's alone: it ends with it.
      if (r.report === 'reply') void deps.agent.stop(session).catch(() => {})
    },

    end(id, session) {
      const r = runtimes.get(id)
      if (r === undefined) return
      if (r.timer !== null) clearTimeout(r.timer)
      r.final?.done()
      for (const w of r.waiting.splice(0)) w.sent(false)
      runtimes.delete(id)
      // A kept run is the meeting's alone: it ends with it.
      if (r.report === 'reply' && session !== undefined) {
        void deps.agent.stop(session).catch(() => {})
      }
    },

    dispose() {
      disposed = true
      for (const r of runtimes.values()) {
        if (r.timer !== null) clearTimeout(r.timer)
        r.final?.done()
        for (const w of r.waiting.splice(0)) w.sent(false)
      }
      runtimes.clear()
    },
  }
}
