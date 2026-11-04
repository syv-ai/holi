/**
 * The `meeting.*` capabilities (docs/features/meetings.md).
 *
 * **The UI door** is the Meetings surface: start and stop a meeting, hand
 * main each chunk of audio, read, rename and delete meetings, split, merge and edit its groups,
 * make a task from lines of it and find related ones, change a task, send
 * one to Claude or a Holi, correct a transcript line, export the minutes,
 * ask the scribe for its next batch now or tell it something (a note, or a
 * change to the groups), and keep this machine's profiles.
 *
 * **The CLI door** is the scribe's alone: `holi meeting group` and
 * `context`, each taking the calling session from `$CLAUDE_JOB_DIR` (`job`).
 * A session that is not the scribe of a meeting that is running is refused,
 * so another session cannot write a meeting's groups. The scribe cites
 * transcript lines by index and code derives the rest (`topics.ts`); tasks
 * and sending are a person's.
 *
 * **The speech key** is the UI's alone: `meeting.key.*` says whether one is
 * set and where it came from, sets, removes and tests it. The key goes in
 * and never comes back out (`speech-key.ts`).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { vaultRelPath } from '@holi/shared'
import {
  cap,
  CapabilityError,
  noParams,
  optionalStringParam,
  paramsObject,
  stringParam,
  vaultNotOpen,
  type CapabilityContext,
} from '../../../main/plugin-api'
import type {
  Card,
  MeetingPhase,
  MeetingProfile,
  MeetingState,
  MeetingSummary,
  Segment,
  SendTarget,
  Topic,
  TopicField,
} from '../shared/meeting'
import { MEETING_SUFFIX } from '../shared/meeting'
import { cardPatchParam, kindOf } from './cards'
import type { Meetings } from './engine'
import { profileParam, type Profiles } from './profiles'
import type { Related } from './related'
import type { TellKind } from './scribe'
import { speechKeyParam, type SpeechKey, type SpeechKeyStatus } from './speech-key'
import { serviceParam, type SpeechServices } from './speech-service'
import { topicPatchParam } from './topics'

export const MEETING_NAMESPACES = ['meeting'] as const

/** A Claude Code background session's job id. */
const JOB_ID = /^[0-9a-f]{8}$/
const MAX_TELL = 4000
/** How long a related-lines query may be: an ask, a title and keywords. */
const MAX_QUERY = 4000
/** The most lines a task or a related query's exclusions name. */
const MAX_LINES = 5000
/** How the person wants a card done: a note, not a document. */
const MAX_CONTEXT = 2000
/** The longest title a meeting may be given. */
const MAX_TITLE = 120
/** A transcript line's words, as a person corrects them. */
const MAX_LINE = 2000
/** A Holi's id: its folder's name. */
const HOLI_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export interface MeetingCapabilitiesDeps {
  meetings: Meetings
  profiles: Profiles
  speechKey: SpeechKey
  services: SpeechServices
  /** The speech service changed: wake every vault's waiting uploads. */
  serviceChanged(): void
  /** The vault this plugin runs in: every verb acts there alone. */
  remote: string
}

function number(raw: Record<string, unknown>, key: string, integer = false): number {
  const value = raw[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CapabilityError('BAD_REQUEST', `${key} must be a number, 0 or more`)
  }
  if (integer && !Number.isInteger(value)) {
    throw new CapabilityError('BAD_REQUEST', `${key} must be a whole number`)
  }
  return value
}

/** The calling session, which the `holi` script fills in from inside one. */
function sessionParam(raw: Record<string, unknown>): string {
  const session = raw['session']
  if (typeof session !== 'string' || !JOB_ID.test(session)) {
    throw new CapabilityError(
      'BAD_REQUEST',
      'run this from the meeting scribe session: it is how Holi knows which meeting',
    )
  }
  return session
}

/** Who a card goes to: the vault's agent, or a Holi by its id. */
function targetParam(raw: unknown): SendTarget | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CapabilityError('BAD_REQUEST', 'target is {kind: agent} or {kind: holi, id}')
  }
  const t = raw as Record<string, unknown>
  // `claude` is what a send said before the vault's agent was chosen.
  if (t['kind'] === 'agent' || t['kind'] === 'claude') return { kind: 'agent' }
  if (t['kind'] === 'holi' && typeof t['id'] === 'string' && HOLI_ID.test(t['id'])) {
    return { kind: 'holi', id: t['id'] }
  }
  throw new CapabilityError('BAD_REQUEST', 'target is {kind: agent} or {kind: holi, id}')
}

const meetingParams = (raw: unknown) => ({
  meetingId: stringParam(paramsObject(raw), 'meetingId'),
})

/** A list of transcript lines, by their `i`. */
function linesParam(raw: Record<string, unknown>, key: string): number[] {
  const lines = raw[key]
  if (
    !Array.isArray(lines) ||
    lines.length > MAX_LINES ||
    lines.some((i) => typeof i !== 'number' || !Number.isInteger(i) || i < 0)
  ) {
    throw new CapabilityError('BAD_REQUEST', `${key} is a list of line numbers`)
  }
  return lines as number[]
}

/** The vault folder a meeting goes in: '' the root, else a safe vault
 *  path, never inside another meeting. */
function folderParam(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new CapabilityError('BAD_REQUEST', 'folder must be a path')
  if (raw === '') return ''
  let folder: string
  try {
    folder = vaultRelPath(raw)
  } catch (err) {
    throw new CapabilityError('BAD_REQUEST', err instanceof Error ? err.message : String(err))
  }
  if (folder.split('/').some((part) => part.endsWith(MEETING_SUFFIX))) {
    throw new CapabilityError('BAD_REQUEST', 'a meeting cannot go inside another meeting')
  }
  return folder
}

/** A meeting folder to start in: a safe vault path ending in `.meeting`,
 *  never inside another meeting. */
function meetingPathParam(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const bad = () =>
    new CapabilityError('BAD_REQUEST', 'path is a meeting folder, ending in .meeting')
  if (typeof raw !== 'string' || !raw.endsWith(MEETING_SUFFIX)) throw bad()
  const stem = folderParam(raw.slice(0, -MEETING_SUFFIX.length))
  if (stem === undefined || stem === '' || stem.endsWith('/')) throw bad()
  return raw
}

/** The group, and suggestion, a task was made from. */
function fromParam(raw: unknown): { topicId: string; suggestionId?: string } | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CapabilityError('BAD_REQUEST', 'from is {topicId, suggestionId?}')
  }
  const p = raw as Record<string, unknown>
  const topicId = stringParam(p, 'topicId')
  const suggestionId = optionalStringParam(p, 'suggestionId')
  return { topicId, ...(suggestionId === undefined ? {} : { suggestionId }) }
}

/** What `holi meeting context` tells the scribe. */
export interface ScribeContext {
  meeting: { title: string; startedAt: number; phase: MeetingPhase }
  profile: Pick<
    MeetingProfile,
    'name' | 'platform' | 'focus' | 'ignore' | 'language' | 'glossary' | 'instructions'
  >
  /** The tasks people made. */
  tasks: Array<Pick<Card, 'id' | 'kind' | 'title' | 'status'>>
  /** The groups, in order. */
  groups: Array<{
    startIndex: number
    title: string
    open: boolean
    stale: boolean
    edited: TopicField[]
  }>
  /** The index of the last transcript line, -1 before any. */
  lastSegment: number
}

export const meetingCapabilities = (deps: MeetingCapabilitiesDeps) => {
  const { meetings, profiles, speechKey } = deps
  const here = (ctx: CapabilityContext): void => {
    if (ctx.remote !== deps.remote) throw vaultNotOpen()
  }

  return {
    'meeting.start': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const title = optionalStringParam(p, 'title')
        const profileId = optionalStringParam(p, 'profileId')
        const folder = folderParam(p['folder'])
        const path = meetingPathParam(p['path'])
        return {
          ...(profileId === undefined ? {} : { profileId }),
          ...(title === undefined ? {} : { title }),
          ...(folder === undefined ? {} : { folder }),
          ...(path === undefined ? {} : { path }),
        }
      },
      run: async (ctx, args): Promise<{ meetingId: string }> => {
        here(ctx)
        return meetings.start(args)
      },
    }),

    /** The New menu's meeting: its folder, made for Record to start in. */
    'meeting.prepare': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const title = optionalStringParam(p, 'title') ?? ''
        if (title.length > MAX_TITLE) {
          throw new CapabilityError('BAD_REQUEST', `title is over ${MAX_TITLE} characters`)
        }
        return { folder: folderParam(p['folder']) ?? '', title }
      },
      run: async (ctx, args): Promise<{ path: string }> => {
        here(ctx)
        return meetings.prepare(args)
      },
    }),

    /** One chunk of captured audio: a 16 kHz, 16-bit WAV, base64. */
    'meeting.chunk': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const audio = stringParam(p, 'audio')
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) {
          throw new CapabilityError('BAD_REQUEST', 'audio must be base64')
        }
        return {
          meetingId: stringParam(p, 'meetingId'),
          n: number(p, 'n', true),
          start: number(p, 'start'),
          duration: number(p, 'duration'),
          audio,
        }
      },
      run: async (ctx, { audio, ...args }): Promise<{ ok: true }> => {
        here(ctx)
        await meetings.chunk({ ...args, audio: new Uint8Array(Buffer.from(audio, 'base64')) })
        return { ok: true }
      },
    }),

    /** The renderer gave up on a chunk: the transcript goes on past it. */
    'meeting.chunk.lost': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return {
          meetingId: stringParam(p, 'meetingId'),
          n: number(p, 'n', true),
          start: number(p, 'start'),
          duration: number(p, 'duration'),
        }
      },
      run: async (ctx, args): Promise<{ ok: true }> => {
        here(ctx)
        await meetings.lose(args)
        return { ok: true }
      },
    }),

    'meeting.stop': cap({
      doors: ['ui'],
      params: meetingParams,
      run: async (ctx, { meetingId }): Promise<{ ok: true }> => {
        here(ctx)
        await meetings.stop(meetingId)
        return { ok: true }
      },
    }),

    'meeting.get': cap({
      doors: ['ui'],
      params: meetingParams,
      run: async (ctx, { meetingId }): Promise<MeetingState> => {
        here(ctx)
        return meetings.get(meetingId)
      },
    }),

    'meeting.list': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx): Promise<MeetingSummary[]> => {
        here(ctx)
        return meetings.list()
      },
    }),

    /** A person renames a meeting: its title, not its folder. */
    'meeting.rename': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return { meetingId: stringParam(p, 'meetingId'), title: stringParam(p, 'title') }
      },
      run: async (ctx, { meetingId, title }): Promise<MeetingSummary> => {
        here(ctx)
        return meetings.rename(meetingId, title)
      },
    }),

    /** A person deletes a finished meeting; the tasks made from it stay. */
    'meeting.delete': cap({
      doors: ['ui'],
      params: meetingParams,
      run: async (ctx, { meetingId }): Promise<{ ok: true }> => {
        here(ctx)
        await meetings.remove(meetingId)
        return { ok: true }
      },
    }),

    /** A person's change to a task: its words, or accepting or dismissing it. */
    'meeting.card': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return {
          meetingId: stringParam(p, 'meetingId'),
          cardId: stringParam(p, 'cardId'),
          patch: cardPatchParam(p['patch']),
        }
      },
      run: async (ctx, { meetingId, cardId, patch }): Promise<Card> => {
        here(ctx)
        return meetings.patchCard(meetingId, cardId, patch)
      },
    }),

    'meeting.group': cap({
      doors: ['cli'],
      cli: {
        // As an argument or on stdin (a here-string): Claude Code's shell
        // checks refuse JSON in a heredoc. Both at once is refused as given
        // twice.
        args: ['json?'],
        summary:
          "write one of this meeting's groups: {startIndex,title,keywords,summary?,decisions?,questions?,suggestions?} as the argument or on stdin (the scribe's)",
        stdin: 'json',
        job: 'session',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        return { session: sessionParam(p), json: stringParam(p, 'json') }
      },
      run: async (ctx, { session, json }): Promise<{ topic: Topic; kept: TopicField[] }> => {
        here(ctx)
        return meetings.group(session, json)
      },
      // What the scribe is told: the group as saved, and what it could not change.
      text: ({ topic, kept }) =>
        [
          JSON.stringify({
            startIndex: topic.lines[0],
            lines: [topic.lines[0], topic.lines.at(-1)],
            open: topic.open,
            title: topic.title,
            suggestions: topic.suggestions.map((s) => ({ id: s.id, title: s.title })),
          }),
          ...(kept.length === 0
            ? []
            : [
                `not changed: ${kept.join(', ')}. The person edited ${kept.length === 1 ? 'that field' : 'those fields'}, and theirs stay${kept.length === 1 ? 's' : ''}; leave ${kept.length === 1 ? 'it' : 'them'} out for this group`,
              ]),
        ].join('\n'),
    }),

    'meeting.context': cap({
      doors: ['cli'],
      cli: {
        args: [],
        summary:
          "this meeting's profile, its groups, the person's tasks and the last transcript line (the scribe's)",
        job: 'session',
      },
      params: (raw) => ({ session: sessionParam(paramsObject(raw)) }),
      run: async (ctx, { session }): Promise<ScribeContext> => {
        here(ctx)
        const { meeting, profile } = meetings.scribing(session)
        return {
          meeting: { title: meeting.title, startedAt: meeting.startedAt, phase: meeting.phase },
          profile: {
            name: profile.name,
            platform: profile.platform,
            focus: profile.focus,
            ignore: profile.ignore,
            language: profile.language,
            glossary: profile.glossary,
            instructions: profile.instructions,
          },
          tasks: meeting.cards
            .filter((c) => c.origin === 'person' && c.status !== 'dismissed')
            .map(({ id, kind, title, status }) => ({ id, kind, title, status })),
          groups: meeting.topics.map((t) => ({
            startIndex: t.lines[0] ?? 0,
            title: t.title,
            open: t.open,
            stale: t.stale === true || (!t.open && t.summary.length === 0),
            edited: t.edited ?? [],
          })),
          lastSegment: meeting.segments.at(-1)?.i ?? -1,
        }
      },
      text: (c) =>
        [
          `meeting: ${c.meeting.title} (${c.meeting.phase})`,
          `profile: ${c.profile.name}`,
          `last segment: ${c.lastSegment}`,
          c.groups.length === 0 ? 'groups: none' : 'groups (startIndex, title):',
          ...c.groups.map(
            (g) =>
              `  ${g.startIndex}\t${g.title === '' ? '(untitled)' : g.title}${g.open ? '\t(open)' : ''}${g.stale ? '\t(not written: write it in full)' : ''}${g.edited.length > 0 ? `\t(the person’s: ${g.edited.join(', ')})` : ''}`,
          ),
          c.tasks.length === 0 ? 'tasks the person made: none' : 'tasks the person made:',
          ...c.tasks.map((t) => `  ${t.id}\t${t.kind}\t${t.title}`),
        ].join('\n'),
    }),

    /** Send a card to an agent, with how the person wants it done: a Claude
     *  session, or a Holi. A person's press; the UI calls it Send. */
    'meeting.build': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const context = optionalStringParam(p, 'context')?.trim()
        if (context !== undefined && context.length > MAX_CONTEXT) {
          throw new CapabilityError('BAD_REQUEST', `context is over ${MAX_CONTEXT} characters`)
        }
        const target = targetParam(p['target'])
        return {
          meetingId: stringParam(p, 'meetingId'),
          cardId: stringParam(p, 'cardId'),
          ...(context === undefined || context === '' ? {} : { context }),
          ...(target === undefined ? {} : { target }),
        }
      },
      run: async (ctx, { meetingId, cardId, ...opts }): Promise<{ sessionId: string }> => {
        here(ctx)
        return meetings.build(meetingId, cardId, opts)
      },
    }),

    /** A person corrects a transcript line's words. */
    'meeting.segment.edit': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const text = stringParam(p, 'text').replace(/\s+/g, ' ').trim()
        if (text === '') throw new CapabilityError('BAD_REQUEST', 'text is empty')
        if (text.length > MAX_LINE) {
          throw new CapabilityError('BAD_REQUEST', `text is over ${MAX_LINE} characters`)
        }
        return { meetingId: stringParam(p, 'meetingId'), i: number(p, 'i', true), text }
      },
      run: async (ctx, { meetingId, i, text }): Promise<Segment> => {
        here(ctx)
        return meetings.editSegment(meetingId, i, text)
      },
    }),

    /** A person replaces a misheard word in the transcript: the first line
     *  it is in, or every line. Each changed line is a correction. */
    'meeting.segment.replace': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const find = stringParam(p, 'find')
        const replace = typeof p['replace'] === 'string' ? p['replace'] : ''
        if (find.length > MAX_LINE || replace.length > MAX_LINE) {
          throw new CapabilityError(
            'BAD_REQUEST',
            `find and replace are at most ${MAX_LINE} characters`,
          )
        }
        return { meetingId: stringParam(p, 'meetingId'), find, replace, all: p['all'] === true }
      },
      run: async (ctx, { meetingId, find, replace, all }): Promise<Segment[]> => {
        here(ctx)
        return meetings.replaceText(meetingId, find, replace, all)
      },
    }),

    /** The minutes as a markdown file where the person chose in the save
     *  dialog: in the vault, written as every vault file is. */
    'meeting.export': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return { meetingId: stringParam(p, 'meetingId'), out: stringParam(p, 'out') }
      },
      run: async (ctx, { meetingId, out }): Promise<{ path: string; vaultPath: string | null }> => {
        here(ctx)
        return meetings.exportMinutes(meetingId, out)
      },
    }),

    /** A note from the person to the scribe, sent at once; `minutes` asks
     *  it to change the groups the minutes are built from. */
    'meeting.tell': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const text = stringParam(p, 'text').trim()
        if (text === '') throw new CapabilityError('BAD_REQUEST', 'text is empty')
        if (text.length > MAX_TELL) {
          throw new CapabilityError('BAD_REQUEST', `text is over ${MAX_TELL} characters`)
        }
        const kind = p['kind']
        if (kind !== undefined && kind !== 'note' && kind !== 'minutes') {
          throw new CapabilityError('BAD_REQUEST', 'kind is note or minutes')
        }
        return {
          meetingId: stringParam(p, 'meetingId'),
          text,
          ...(kind === 'minutes' ? { kind: 'minutes' as TellKind } : {}),
        }
      },
      run: async (ctx, { meetingId, text, kind }): Promise<{ ok: true }> => {
        here(ctx)
        await meetings.tell(meetingId, text, kind)
        return { ok: true }
      },
    }),

    /** The scribe's next batch now, however little transcript waits. */
    'meeting.summarise': cap({
      doors: ['ui'],
      params: meetingParams,
      run: async (ctx, { meetingId }): Promise<{ ok: true }> => {
        here(ctx)
        await meetings.summarise(meetingId)
        return { ok: true }
      },
    }),

    /** A person's task from lines of the meeting (a group's, a
     *  suggestion's, related ones, a stretch's) and what they want done.
     *  Made at once, accepted; Send sends it. */
    'meeting.task.create': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const title = optionalStringParam(p, 'title')
        const from = fromParam(p['from'])
        const cardId = optionalStringParam(p, 'cardId')
        return {
          meetingId: stringParam(p, 'meetingId'),
          lines: linesParam(p, 'lines'),
          prompt: stringParam(p, 'prompt'),
          kind: kindOf(p['kind']),
          ...(title === undefined ? {} : { title }),
          ...(from === undefined ? {} : { from }),
          ...(cardId === undefined ? {} : { cardId }),
        }
      },
      run: async (ctx, { meetingId, ...req }): Promise<Card> => {
        here(ctx)
        return meetings.createTask(meetingId, req)
      },
    }),

    /** The windows of the meeting outside `exclude` that best match a
     *  query: what Send offers to carry along. */
    'meeting.related': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const query = stringParam(p, 'query')
        if (query.length > MAX_QUERY) {
          throw new CapabilityError('BAD_REQUEST', `query is over ${MAX_QUERY} characters`)
        }
        return {
          meetingId: stringParam(p, 'meetingId'),
          query,
          exclude: p['exclude'] === undefined ? [] : linesParam(p, 'exclude'),
        }
      },
      run: async (ctx, { meetingId, query, exclude }): Promise<Related[]> => {
        here(ctx)
        return meetings.related(meetingId, query, exclude)
      },
    }),

    /** A person starts a new group at a line. */
    'meeting.group.split': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return { meetingId: stringParam(p, 'meetingId'), i: number(p, 'i', true) }
      },
      run: async (ctx, { meetingId, i }): Promise<Topic[]> => {
        here(ctx)
        return meetings.splitGroup(meetingId, i)
      },
    }),

    /** A person joins a group to the one before it. */
    'meeting.group.merge': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return { meetingId: stringParam(p, 'meetingId'), groupId: stringParam(p, 'groupId') }
      },
      run: async (ctx, { meetingId, groupId }): Promise<Topic[]> => {
        here(ctx)
        return meetings.mergeGroup(meetingId, groupId)
      },
    }),

    /** A person joins a group to another's topic, from anywhere in the
     *  meeting: one topic, each group's lines where they were. */
    'meeting.group.join': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return {
          meetingId: stringParam(p, 'meetingId'),
          groupId: stringParam(p, 'groupId'),
          into: stringParam(p, 'into'),
        }
      },
      run: async (ctx, { meetingId, groupId, into }): Promise<Topic[]> => {
        here(ctx)
        return meetings.joinGroup(meetingId, groupId, into)
      },
    }),

    /** A person separates a joined topic into its groups again. */
    'meeting.group.separate': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return { meetingId: stringParam(p, 'meetingId'), groupId: stringParam(p, 'groupId') }
      },
      run: async (ctx, { meetingId, groupId }): Promise<Topic[]> => {
        here(ctx)
        return meetings.separateGroup(meetingId, groupId)
      },
    }),

    /** A person edits a group's words: theirs from then on. */
    'meeting.group.edit': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return {
          meetingId: stringParam(p, 'meetingId'),
          groupId: stringParam(p, 'groupId'),
          patch: topicPatchParam(p['patch']),
        }
      },
      run: async (ctx, { meetingId, groupId, patch }): Promise<Topic> => {
        here(ctx)
        return meetings.editGroup(meetingId, groupId, patch)
      },
    }),

    'meeting.profiles.list': cap({
      doors: ['ui'],
      params: noParams,
      run: (): Promise<MeetingProfile[]> => profiles.list(),
    }),

    'meeting.profiles.save': cap({
      doors: ['ui'],
      params: (raw) => ({ profile: profileParam(paramsObject(raw)['profile']) }),
      run: (_ctx, { profile }): Promise<MeetingProfile> => profiles.save(profile),
    }),

    'meeting.profiles.delete': cap({
      doors: ['ui'],
      params: (raw) => ({ id: stringParam(paramsObject(raw), 'id') }),
      run: async (_ctx, { id }): Promise<{ ok: true }> => {
        await profiles.delete(id)
        return { ok: true }
      },
    }),

    /** Whether a speech key is set, and where it came from: never the key. */
    'meeting.key.status': cap({
      doors: ['ui'],
      params: noParams,
      run: (): Promise<SpeechKeyStatus> => speechKey.status(),
    }),

    /** Keep a speech key on this machine, then send what waited for one. */
    'meeting.key.set': cap({
      doors: ['ui'],
      params: (raw) => ({ key: speechKeyParam(paramsObject(raw)) }),
      run: async (_ctx, { key }): Promise<{ ok: true }> => {
        await speechKey.set(key)
        return { ok: true }
      },
    }),

    /** Remove this machine's key: the vault's `SYV_API_KEY` applies, if any. */
    'meeting.key.clear': cap({
      doors: ['ui'],
      params: noParams,
      run: async (): Promise<{ ok: true }> => {
        await speechKey.clear()
        return { ok: true }
      },
    }),

    /** Transcribe with syv.ai (`url` null) or another service that answers
     *  `/audio/transcriptions`: its address and model, on this machine. */
    'meeting.service.set': cap({
      doors: ['ui'],
      params: (raw) => serviceParam(paramsObject(raw)),
      run: async (_ctx, service): Promise<SpeechKeyStatus> => {
        await deps.services.set(service)
        deps.serviceChanged()
        return speechKey.status()
      },
    }),

    /** Ask the service whether the key in use works, spending no credits. */
    'meeting.key.test': cap({
      doors: ['ui'],
      params: noParams,
      run: () => speechKey.test(),
    }),
  }
}
