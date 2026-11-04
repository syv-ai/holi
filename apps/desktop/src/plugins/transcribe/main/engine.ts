/**
 * The meeting engine (docs/features/meetings.md): chunks in, transcript,
 * groups, minutes and tasks out.
 *
 * - **No audio is lost.** A chunk is written to
 *   `userData/meetings/<id>/chunk-<n>.wav` before anything else happens to
 *   it, and the meeting's state to `state.json` beside it, so a crash or a
 *   reload picks up where it was: a meeting left recording uploads what it
 *   has and is finished. A chunk's audio is deleted once its transcript is
 *   stored, unless the profile keeps audio.
 * - **Uploads** go two chunks at a time, each as a mono mix (`wav.ts`), or,
 *   when both sides speak in it, as its two channels in two requests at once,
 *   so each line is labelled by the channel it came from (`stitcher.ts`). A
 *   failed one is tried again after 1, 3, 9 and 27 seconds, then marked
 *   failed and tried again when a later chunk gets through or the meeting
 *   stops.
 * - **The speech key** (`speech-key.ts`) is not something a retry fixes.
 *   Without one, or with one the service refused (401, 403), a chunk is not
 *   sent: it stays queued with its audio on disk, the meeting says why
 *   (`blocked`), and `wake` sends it once the key changes. A meeting does
 *   not finish past a chunk waiting for the key. A meeting that ended with
 *   chunks failed for the key alone, their audio still on disk, is picked up
 *   at load and finished again, without a scribe (`rescue`).
 * - **The transcript** is stitched in chunk order (`stitcher.ts`), and
 *   written to the meeting's folder in the vault with the minutes:
 *   `Meetings/<date> <title>/transcript.local.md` and `minutes.local.md`
 *   (`minutes.md` when the profile shares them). Machine-local by default:
 *   a client meeting is not the vault's to push.
 * - **The groups** (`topics.ts`) are the meeting's backbone: the scribe
 *   writes them (`holi meeting group`), a person splits, merges and edits
 *   them, and the minutes are rendered from them by code (`minutes.ts`) on
 *   every change. A field a person edited is theirs.
 * - **A person's corrections** (a line's words, a group's fields) are the
 *   transcript's and the minutes' from then on: quotes follow a corrected
 *   line, the files are written again, and the scribe hears both with its
 *   next batch (`ScribeNotes`).
 * - **Tasks** are a person's: made from a group, a suggestion or a stretch
 *   of lines (`cards.ts`), and sent to Claude or a Holi with every line they
 *   carry (`build.ts`).
 * - **The renderer** hears `meeting` (one meeting's state, at most four times
 *   a second) and `meetings` (the list).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { isLocalOnlyPath, type AgentProviderId } from '@holi/shared'
import { randomBytes } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { CapabilityError } from '../../../main/plugin-api'
import type {
  Card,
  ChunkInfo,
  MeetingBlock,
  MeetingProfile,
  MeetingState,
  MeetingSummary,
  Segment,
  SendTarget,
  SpeechService,
  Topic,
  TopicField,
} from '../shared/meeting'
import { tidyJoins } from '../shared/joins'
import { clock } from '../shared/scribe-prompt'
import { keyRefused, transcribe, type Fetch } from './asr'
import { buildBrief, cardSpec } from './build'
import { applyPatch, requote, taskCard, type CardPatch, type TaskRequest } from './cards'
import { renderMinutes } from './minutes'
import { MEETING_SUFFIX, speakerName } from '../shared/meeting'
import { DEFAULT_ASR_MODEL, DEFAULT_PROFILE, type Profiles } from './profiles'
import { relatedWindows, type Related } from './related'
import { isSyv, SYV_SERVICE } from './speech-service'
import {
  createScribe,
  type AgentCalls,
  type Scribe,
  type ScribeNotes,
  type TellKind,
} from './scribe'
import { stitch, type ChunkSegment } from './stitcher'
import {
  applyGroup,
  closeTopics,
  editTopic,
  extendTopics,
  joinTopic,
  mergeTopic,
  separateTopic,
  parseGroup,
  splitTopic,
  type TopicPatch,
} from './topics'
import { transcribeChunk, type ChunkVad } from './vad'
import { parseWav, wavSeconds, type Pcm } from './wav'

/** The waits before each retry of a failed upload. */
const UPLOAD_RETRY_MS = [1000, 3000, 9000, 27_000] as const
/** Uploads at once. */
const CONCURRENCY = 2
/** How long the scribe gets for its final pass once a meeting stops. */
const FINISH_MS = 3 * 60_000
/** At most this often, the renderer hears a meeting's state. */
const EMIT_MS = 250
const PERSIST_MS = 500
const FILES_MS = 2000
/** What a chunk that failed for want of a key said before keys were Holi's. */
const LEGACY_NO_KEY = "SYV_API_KEY is not set in the vault's .env.local"
const NO_KEY = 'no speech key is set'
/** What a chunk the renderer gave up on says. */
const LOST = 'never reached Holi'
const BAD_KEY = 'the speech key was refused'

/** Whether a chunk failed for the key and nothing else. */
const keyFailure = (c: ChunkInfo): boolean =>
  (c.state === 'failed' || c.state === 'queued') &&
  c.error !== undefined &&
  (c.error === LEGACY_NO_KEY ||
    c.error === NO_KEY ||
    c.error === BAD_KEY ||
    /^transcription failed: 40[13]\b/.test(c.error))

/** A chunk is seconds of audio: this is far past any. */
const MAX_CHUNK_BYTES = 16 * 1024 * 1024
/** How long a meeting's folder may be missing before the meeting counts as
 *  deleted: a folder move removes its files before it writes them again. */
const GONE_MS = 5000

/** Where a meeting whose folder left the vault is kept on this machine
 *  (under the meetings folder, named `<id>-<when>`), and for how long. */
const REMOVED = '.removed'
const REMOVED_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** What `prepare` writes before a meeting records, which `start` may take. */
const NOT_RECORDED = 'Not recorded yet: open this meeting and press Record.'
/** How the placeholder starts, so it is known by its first bytes, whatever
 *  the length of the title after it. */
const PLACEHOLDER_HEAD = '---\nmeeting: not recorded\n---\n'
/** A machine-local file in the vault naming this clone of it, made the
 *  first time the engine runs in it: a clone made again has a new one. */
const CLONE_FILE = '.holi/meetings.local.json'
/** The folder a vault path is in ('' at the root). */
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))
/** The id at the top of a meeting's transcript. */
const MARK = /^---\nmeeting: ([0-9a-f]{12})\n---\n/

/** What `state.json` holds: the meeting, and what only main needs of it. */
interface Stored {
  version: 1
  /** The vault the meeting belongs to. */
  remote: string
  meeting: MeetingState
  /** The profile as it was when the meeting started. */
  profile: MeetingProfile
  /** The next chunk the transcript waits for. */
  next: number
  /** Transcribed chunks waiting for an earlier one. */
  pending: Record<number, ChunkSegment[]>
  /** What a person changed that the scribe has not been sent yet. */
  notes?: ScribeNotes
  /** Its transcript in the vault carries its id (`transcriptMarkdown`), so
   *  its folder is known by that wherever it is moved. A meeting saved before
   *  that has none until its transcript is written again. */
  marked?: true
  /** The clone of the vault its folder was last seen in (`CLONE_FILE`). Its
   *  folder missing from that clone was deleted; missing from another, it
   *  never came with the clone (it held only this machine's files). */
  clone?: string
}

interface Live {
  stored: Stored
  /** When main received each chunk, for its latency. */
  received: Map<number, number>
  /** Chunks that failed for good: the transcript stitches past them. */
  skip: Set<number>
  /** Failed chunks already tried again once a later one got through. */
  revived: Set<number>
  persistTimer: ReturnType<typeof setTimeout> | null
  filesTimer: ReturnType<typeof setTimeout> | null
  emitTimer: ReturnType<typeof setTimeout> | null
  lastEmit: number
  /** The text last written to each vault file. */
  written: Map<string, string>
  /** Chunks whose upload is running, to its last step. */
  inflight: Set<number>
  /** Resolved when no chunk is queued or uploading. */
  flushed: Array<() => void>
  /** Chunks waiting, untried, for a speech key that works. */
  parked: Set<number>
  /** Finished again after it ended (`rescue`): its scribe is gone and is
   *  not started again. */
  rescued: boolean
  /** Started in this run and not written yet: its folder may be made, or
   *  take over the placeholder `prepare` wrote. */
  fresh: boolean
}

interface TaskCalls {
  createTask(args: { title: string; folder: string; description: string }): Promise<{
    path: string
  }>
  /** Replace a task's text (`tasks.update`). */
  updateTask(args: { path: string; description: string }): Promise<void>
}

/** The Holis plugin's send (`holis.send`): a document to an approved Holi. */
interface HoliCalls {
  sendToHoli(args: { holi: string; path: string }): Promise<{ sessionId: string }>
}

/** How a person sends a card (`meeting.build`). */
interface SendOptions {
  /** How they want it done, in their words. */
  context?: string
  /** The vault's agent, unless a Holi is named. */
  target?: SendTarget
}

export interface MeetingsDeps {
  /** `userData/meetings`. */
  dir: string
  remote: string
  /** The vault clone. */
  root: string
  profiles: Pick<Profiles, 'get' | 'list'>
  fetch: Fetch
  /** The speech key bound to `service` (`speech-key.ts`), or null. */
  apiKey(service: SpeechService): Promise<string | null>
  /** The speech service in use (`speech-service.ts`). */
  service(): Promise<SpeechService>
  /** Write a vault file (`vault-write.ts`), unless `guard`, asked under the
   *  file's lock, says no. Whether it wrote. */
  writeFile(rel: string, text: string, guard?: () => Promise<boolean>): Promise<boolean | void>
  /** Whether `rel` is a folder in the vault now. */
  folderExists(rel: string): Promise<boolean>
  /** Remove vault files, then `folder` if nothing else is left in it. */
  removeFiles(rels: readonly string[], folder: string): Promise<void>
  /** The start of a vault file, or null when there is none (`vault-write.ts`). */
  readHead(rel: string): Promise<string | null>
  /** The vault's folders as last scanned. */
  folders(): readonly string[]
  emit(name: 'meeting' | 'meetings' | 'meeting-removed', payload: unknown): void
  agent: AgentCalls & TaskCalls & HoliCalls
  /** The vault's chosen agent (Settings, General, Agents), read fresh. */
  provider(): Promise<AgentProviderId>
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  now?: () => number
  /** Voice detection before upload (`vad.ts`); absent, chunks go up whole. */
  vad?: ChunkVad
}

export interface Meetings {
  /** Read this vault's meetings from disk and pick up any left unfinished. */
  load(): Promise<void>
  /** A meeting starts recording: with a profile, else this machine's
   *  first; in `folder` (a vault folder, '' the root), else `Meetings`, or
   *  at `path`, a meeting folder `prepare` made. */
  start(args: { title?: string; profileId?: string; folder?: string; path?: string }): Promise<{
    meetingId: string
  }>
  /** The New menu's meeting: its folder in `folder`, made now with a
   *  placeholder transcript so the tree opens it as the meeting, where Record
   *  starts it (`start` with `path`). Nothing records until then. */
  prepare(args: { folder: string; title: string }): Promise<{ path: string }>
  chunk(args: {
    meetingId: string
    n: number
    start: number
    duration: number
    audio: Uint8Array
  }): Promise<void>
  /** The renderer gave up on chunk `n`: it never arrives, so the
   *  transcript stitches past it rather than wait for it until the stop. */
  lose(args: { meetingId: string; n: number; start: number; duration: number }): Promise<void>
  stop(meetingId: string): Promise<void>
  /** Resolves once no meeting records, or after `ms`: what a recording
   *  still has to hand over arrives before the engine goes. */
  drain(ms: number): Promise<void>
  get(meetingId: string): Promise<MeetingState>
  list(): MeetingSummary[]
  /** A person renames a meeting: its title, not its folder. */
  rename(meetingId: string, title: string): Promise<MeetingSummary>
  /** A person deletes a finished meeting: its state on this machine and the
   *  transcript and minutes it wrote; the tasks made from it stay. */
  remove(meetingId: string): Promise<void>
  /**
   * The vault changed: each meeting finds its folder again by the id its
   * transcript carries. A folder renamed or moved takes its meeting with it;
   * one deleted (missing for `GONE_MS`) deletes its meeting here, its
   * recording stopped first (`meeting-removed`). A folder at a meeting's old
   * path that is not that meeting's is never taken for it.
   */
  follow(): Promise<void>
  patchCard(meetingId: string, cardId: string, patch: CardPatch): Promise<Card>
  /** Send a card to an agent: a Claude session, or a Holi. */
  build(meetingId: string, cardId: string, opts?: SendOptions): Promise<{ sessionId: string }>
  /** A person's word to the scribe: a note, or a change to the groups. */
  tell(meetingId: string, text: string, kind?: TellKind): Promise<void>
  /** The person pressed Summarise now: the scribe's next batch goes as soon
   *  as it is idle. */
  summarise(meetingId: string): Promise<void>
  /** A person starts the scribe of a recording meeting again, after it
   *  stopped or could not start (on the agent chosen then): a new session,
   *  sent the whole transcript with the groups so far. */
  restartScribe(meetingId: string): Promise<void>
  /** A person makes a task from lines of the meeting, with what they want
   *  done; the scribe hears of it with its next batch. */
  createTask(meetingId: string, req: TaskRequest): Promise<Card>
  /** The windows of the meeting outside `exclude` that best match `query`. */
  related(meetingId: string, query: string, exclude: readonly number[]): Promise<Related[]>
  /** A person starts a new group at line `i`. */
  splitGroup(meetingId: string, i: number): Promise<Topic[]>
  /** A person joins a group to the one before it. */
  mergeGroup(meetingId: string, groupId: string): Promise<Topic[]>
  /** A person joins a group, from anywhere in the meeting, to another's
   *  topic: the lines stay where they are. */
  joinGroup(meetingId: string, groupId: string, into: string): Promise<Topic[]>
  /** A person separates a joined topic into its groups again. */
  separateGroup(meetingId: string, groupId: string): Promise<Topic[]>
  /** A person edits a group's fields, which are theirs from then on. */
  editGroup(meetingId: string, groupId: string, patch: TopicPatch): Promise<Topic>
  /** A person corrected a transcript line's words. */
  editSegment(meetingId: string, i: number, text: string): Promise<Segment>
  /** A person replaced a misheard word: its first line, or every line, where
   *  `find` is (any case). The lines it changed, each a correction. */
  replaceText(
    meetingId: string,
    find: string,
    replacement: string,
    all: boolean,
  ): Promise<Segment[]>
  /** Write the minutes, under the meeting's title, to an absolute `.md` path. */
  exportMinutes(meetingId: string, out: string): Promise<{ path: string; vaultPath: string | null }>
  /** The meeting whose scribe `session` is, while it records or finishes;
   *  refused for any other session. */
  scribing(session: string): { meeting: MeetingState; profile: MeetingProfile }
  /** The scribe's group (`holi meeting group`): the group as saved, and the
   *  fields of it a person edited, which it left as they were. */
  group(session: string, json: string): Promise<{ topic: Topic; kept: TopicField[] }>
  scribe: Scribe
  /** The speech key changed: send every chunk that waited for one. */
  wake(): void
  /** Stops the engine; resolves once every meeting's last state is on disk. */
  dispose(): Promise<void>
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Where a meeting goes when no folder is chosen. */
const DEFAULT_PARENT = 'Meetings'
/** The longest title a person may give a meeting. */
const MAX_TITLE = 120

/** A title fit for a folder name: no path or shell-hostile characters, one
 *  line, not empty. */
function folderTitle(title: string): string {
  const cleaned = title
    .replace(/[/\\:*?"<>|\p{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .trim()
  return cleaned === '' ? 'Meeting' : cleaned
}

const summaryOf = (m: MeetingState): MeetingSummary => ({
  id: m.id,
  title: m.title,
  startedAt: m.startedAt,
  phase: m.phase,
  cards: m.cards.length,
  folder: m.folder,
})

/** The minutes file for a profile: shared minutes sync, the default stays here. */
const minutesFile = (folder: string, profile: MeetingProfile): string =>
  `${folder}/${profile.shareMinutes ? 'minutes.md' : 'minutes.local.md'}`

/** A group as this version keeps it, from one saved before groups had
 *  every field (its summary one sentence, no decisions or suggestions). */
function normalTopic(t: Topic): Topic {
  const old = t as Omit<Topic, 'summary'> & { summary: unknown }
  const summary = Array.isArray(old.summary)
    ? (old.summary as string[])
    : typeof old.summary === 'string' && old.summary !== ''
      ? [old.summary]
      : []
  return {
    ...t,
    summary,
    open: t.open === true,
    decisions: t.decisions ?? [],
    questions: t.questions ?? [],
    suggestions: t.suggestions ?? [],
  }
}

/** The transcript as markdown: a heading per topic, a paragraph per turn
 *  with its speaker and time. */
function transcriptMarkdown(m: MeetingState): string {
  const day = new Date(m.startedAt)
  const lines = [
    '---',
    `meeting: ${m.id}`,
    '---',
    '',
    `# ${m.title}`,
    '',
    `Transcript of the meeting on ${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}, transcribed automatically: words can be misheard.`,
  ]
  let speaker: string | null = null
  const topicAt = new Map(m.topics.map((t) => [t.lines[0], t]))
  for (const s of m.segments) {
    const topic = topicAt.get(s.i)
    if (topic !== undefined) {
      const name = topic.title !== '' ? topic.title : topic.open ? 'Now' : 'Untitled'
      lines.push('', `## ${name} · ${clock(topic.start)}`)
      speaker = null
    }
    if (s.speaker !== speaker) {
      lines.push('', `**${speakerName(s.speaker)}** · ${clock(s.start)}`, '')
      speaker = s.speaker
      lines.push(s.text)
    } else {
      lines[lines.length - 1] += ` ${s.text}`
    }
  }
  return `${lines.join('\n')}\n`
}

export function createMeetings(deps: MeetingsDeps): Meetings {
  const now = deps.now ?? Date.now
  const live = new Map<string, Live>()
  /** Every meeting of this vault on disk, by id, as the list shows it. */
  const summaries = new Map<string, MeetingSummary>()
  const queue: Array<{ id: string; n: number }> = []
  let active = 0
  let disposed = false
  let lastList = ''
  /** The key the service last refused: not sent again. */
  let badKey: string | null = null
  /** Bumped by `wake`, so an upload that read the key before it does not
   *  park on what was true then. */
  let keyEpoch = 0
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()

  const dirOf = (id: string) => join(deps.dir, id)

  /** Meetings set aside past their time are erased for good. */
  async function purgeRemoved(): Promise<void> {
    const dir = join(deps.dir, REMOVED)
    const cutoff = now() - REMOVED_DAYS * DAY_MS
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const at = Number(/^[0-9a-f]{12}-(\d+)$/.exec(name)?.[1])
      if (Number.isFinite(at) && at < cutoff) {
        // One that cannot go now goes at a later start; the meetings load.
        await rm(join(dir, name), { recursive: true, force: true, maxRetries: 3 }).catch(
          (err: unknown) => deps.log('warn', `meetings: could not erase ${name}: ${String(err)}`),
        )
      }
    }
  }
  const wavOf = (id: string, n: number) => join(dirOf(id), `chunk-${n}.wav`)

  const scribe = createScribe({
    agent: deps.agent,
    log: deps.log,
    now,
    provider: deps.provider,
    // A tool-less scribe's answer, written as its `holi meeting group` would be.
    group: (session, json) => api.group(session, json),
    host: {
      get: (id) => {
        const l = live.get(id)
        return l === undefined
          ? undefined
          : { meeting: l.stored.meeting, profile: l.stored.profile, notes: notesOf(l) }
      },
      live: () =>
        [...live.values()]
          .filter((l) => !l.rescued)
          .map((l) => l.stored.meeting)
          .filter((m) => m.phase === 'recording' || m.phase === 'finishing'),
      changed: (id) => changed(id),
    },
  })

  const notesOf = (l: Live): ScribeNotes => (l.stored.notes ??= { corrections: {} })

  // --- where each meeting's folder is ---------------------------------------

  /** Meetings whose folder is not where their record says, and that no
   *  folder in the vault claims: listed, but no folder opens them. */
  const away = new Set<string>()
  /** This clone's name (`CLONE_FILE`), read or made at `load`. */
  let cloneId: string | null = null
  /** The clone each meeting's record names, as loaded or since noted. */
  const cloneOf = new Map<string, string | undefined>()
  /** When each meeting's transcript was first found missing. */
  const missing = new Map<string, number>()
  let followTimer: ReturnType<typeof setTimeout> | null = null
  let following: Promise<void> = Promise.resolve()

  const summarize = (m: MeetingState): MeetingSummary =>
    away.has(m.id) ? { ...summaryOf(m), away: true } : summaryOf(m)

  type Mark = { kind: 'meeting'; id: string } | { kind: 'absent' | 'placeholder' | 'unmarked' }

  /** Whose the transcript in `folder` is, by the id it starts with. */
  async function markAt(folder: string): Promise<Mark> {
    const head = await deps.readHead(`${folder}/transcript.local.md`).catch(() => null)
    if (head === null) return { kind: 'absent' }
    const id = MARK.exec(head)?.[1]
    if (id !== undefined) return { kind: 'meeting', id }
    const placeholder = head.startsWith(PLACEHOLDER_HEAD) || head.includes(NOT_RECORDED)
    return { kind: placeholder ? 'placeholder' : 'unmarked' }
  }

  /** Whether the meeting's folder is still its own to write. `adopt`: its
   *  transcript has been missing past `GONE_MS` while its folder stayed
   *  (cloned again, the file deleted by hand), so it is written again. */
  async function mayWrite(l: Live, adopt = false): Promise<boolean> {
    const mark = await markAt(l.stored.meeting.folder)
    if (mark.kind === 'meeting') return mark.id === l.stored.meeting.id
    // Into a folder whose transcript went, never over a file someone put there.
    if (adopt) return mark.kind === 'absent'
    // Its transcript was written there, and is gone or replaced: moved or
    // deleted, or a move under way, which `follow` settles.
    if (l.stored.marked === true) return false
    // A meeting from before transcripts carried ids: its own transcript. A
    // meeting starting now never takes one: it is someone's file.
    if (mark.kind === 'unmarked') return !l.fresh
    // A folder that is not there yet, or a placeholder: only for the meeting
    // starting in it now.
    return l.fresh
  }

  function followAfter(ms: number): void {
    if (followTimer !== null || disposed) return
    followTimer = setTimeout(() => {
      followTimer = null
      void follow()
    }, ms)
  }
  const followSoon = () => followAfter(250)

  function follow(): Promise<void> {
    const run = following.then(followNow, followNow)
    following = run.catch((err: unknown) =>
      deps.log('error', `meeting: could not follow the vault: ${String(err)}`),
    )
    return run
  }

  function setAway(id: string, on: boolean): void {
    if (away.has(id) === on) return
    if (on) away.add(id)
    else away.delete(id)
    const s = summaries.get(id)
    if (s !== undefined) {
      const { away: _was, ...rest } = s
      summaries.set(id, on ? { ...rest, away: true } : rest)
    }
    emitList()
  }

  async function followNow(): Promise<void> {
    if (disposed) return
    /** Every folder whose transcript carries each id, read once a pass and
     *  only when a meeting is not where it was. */
    let marked: Map<string, string[]> | null = null
    const markedFolders = async (): Promise<Map<string, string[]>> => {
      if (marked !== null) return marked
      const found = new Map<string, string[]>()
      for (const dir of deps.folders()) {
        const mark = await markAt(dir)
        if (mark.kind === 'meeting') found.set(mark.id, [...(found.get(mark.id) ?? []), dir])
      }
      marked = found
      return found
    }
    for (const [id, summary] of [...summaries]) {
      if (deleted.has(id) || disposed) continue
      const l = live.get(id)
      if (l?.fresh === true) continue
      const mark = await markAt(summary.folder)
      if (mark.kind === 'meeting' && mark.id === id) {
        missing.delete(id)
        setAway(id, false)
        await noteClone(id)
        continue
      }
      // Its folder was renamed or moved: the meeting follows, into a
      // meeting's folder. A transcript dragged out on its own into another
      // folder is not the meeting moving: the meeting stays and writes its
      // transcript again, and its folder deleted later is a delete. Only a
      // meeting from before folders had the suffix follows into one without
      // it, beside where it was, once its own is gone (renamed in place).
      const candidates = (await markedFolders()).get(id) ?? []
      const moved =
        candidates.find((dir) => dir.endsWith(MEETING_SUFFIX)) ??
        (summary.folder.endsWith(MEETING_SUFFIX) || (await deps.folderExists(summary.folder))
          ? undefined
          : candidates.find((dir) => parentOf(dir) === parentOf(summary.folder)))
      if (moved !== undefined) {
        await relocate(id, moved)
        continue
      }
      const stored = l?.stored ?? (await readStored(id))
      if (stored === null) continue
      if (stored.marked !== true) {
        // From before transcripts carried ids: its own transcript is taken
        // as it is, and anything else at its path is not it.
        if (mark.kind === 'unmarked') {
          setAway(id, false)
          await writeFiles(await open(id))
        } else setAway(id, true)
        continue
      }
      // Its transcript is nowhere: deleted, or a move still under way.
      const since = missing.get(id)
      if (since === undefined) {
        missing.set(id, now())
        followAfter(GONE_MS)
      } else if (now() - since >= GONE_MS) {
        // The folder stayed and only its transcript went (a clone has none,
        // being a machine-local file): the meeting is still there, and its
        // transcript is written again. A file of someone else's in its place
        // is theirs: the meeting waits, away, until its own is back (missing
        // stays set, so this is not timed again). Only a folder gone is a
        // delete.
        //
        // A folder that holds only this machine's files (the transcript, the
        // minutes kept local) is not in git, so a fresh clone has none of
        // it: missing from a clone the meeting was never seen in, that is
        // what happened, and the meeting writes it again. Missing from the
        // clone it was seen in, or holding a shared file git would have
        // brought back, it was deleted, Holi running or not.
        if (await deps.folderExists(summary.folder)) {
          if (mark.kind === 'absent') await adopt(id)
          else setAway(id, true)
        } else if (
          (cloneId !== null && cloneOf.get(id) === cloneId) ||
          sharesFiles(stored.meeting)
        ) {
          await gone(id)
        } else await adopt(id)
      } else {
        followAfter(GONE_MS - (now() - since))
      }
    }
  }

  /** The meeting's folder is now `to`: its paths follow it. */
  async function relocate(id: string, to: string): Promise<void> {
    const l = await open(id)
    const m = l.stored.meeting
    const from = m.folder
    const moved = (p: string): string =>
      p === from || p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p
    m.folder = to
    if (m.minutesPath !== undefined) m.minutesPath = moved(m.minutesPath)
    m.cards = m.cards.map((c) =>
      c.taskPath === undefined ? c : { ...c, taskPath: moved(c.taskPath) },
    )
    // Written again in full where it is now: the move may have carried an
    // older copy of what was last written.
    l.written = new Map()
    missing.delete(id)
    away.delete(id)
    deps.log('info', `meeting "${m.title}": its folder is now ${to}`)
    changed(id)
    // A write that raced the move may have left its minutes behind at the
    // old path, beside no transcript: they go, and the folder with them if
    // that empties it.
    if ((await markAt(from)).kind === 'absent' && (await deps.folderExists(from))) {
      await deps
        .removeFiles([`${from}/minutes.local.md`, `${from}/minutes.md`], from)
        .catch(() => {})
    }
  }

  /** The meeting's transcript went while its folder stayed: written again. */
  async function adopt(id: string): Promise<void> {
    missing.delete(id)
    const l = await open(id)
    l.written = new Map()
    deps.log('info', `meeting "${l.stored.meeting.title}": its transcript is written again`)
    await writeFiles(l, true)
  }

  /** Whether the meeting's folder holds a file git keeps: its minutes when
   *  shared and written, or a task filed there that is not local. */
  const sharesFiles = (m: MeetingState): boolean =>
    [m.minutes.trim() === '' ? undefined : m.minutesPath, ...m.cards.map((c) => c.taskPath)].some(
      (path) => path !== undefined && path.startsWith(`${m.folder}/`) && !isLocalOnlyPath(path),
    )

  /** Record that the meeting's folder is in this clone. */
  async function noteClone(id: string): Promise<void> {
    if (cloneId === null || cloneOf.get(id) === cloneId) return
    cloneOf.set(id, cloneId)
    const l = live.get(id)
    if (l !== undefined) {
      l.stored.clone = cloneId
      persistSoon(l)
      return
    }
    const stored = await readStored(id)
    if (stored === null || deleted.has(id)) return
    stored.clone = cloneId
    await persistStored(stored).catch(() => {})
  }

  /** This clone's name, made and written the first time. */
  async function loadClone(): Promise<string | null> {
    const text = await deps.readHead(CLONE_FILE).catch(() => null)
    try {
      const clone = (JSON.parse(text ?? '') as { clone?: unknown }).clone
      if (typeof clone === 'string' && /^[0-9a-f]{12}$/.test(clone)) return clone
    } catch {
      // None yet, or not ours: made now.
    }
    const clone = randomBytes(6).toString('hex')
    try {
      await deps.writeFile(CLONE_FILE, `${JSON.stringify({ clone })}\n`)
      return clone
    } catch (err) {
      // Kept for this session, so a delete now still holds; the next start
      // takes the vault for a fresh clone.
      deps.log('warn', `meetings: could not write ${CLONE_FILE}: ${String(err)}`)
      return clone
    }
  }

  /** The meeting's folder was deleted from the vault: so is the meeting, its
   *  recording stopped first. What this machine kept of it (the audio, the
   *  transcript) is set aside for `REMOVED_DAYS` rather than erased: a
   *  folder can go by mistake, or by another machine's sync. */
  async function gone(id: string): Promise<void> {
    const l = live.get(id)
    const title = l?.stored.meeting.title ?? summaries.get(id)?.title ?? id
    const phase = l?.stored.meeting.phase ?? summaries.get(id)?.phase
    if (phase === 'recording' || phase === 'finishing') {
      deps.emit('meeting-removed', { meetingId: id })
    }
    await forget(id, true)
    deps.log(
      'info',
      `meeting "${title}": its folder was deleted, so the meeting was too (kept aside for ${REMOVED_DAYS} days)`,
    )
  }

  /** Everything of the meeting on this machine, and nothing in the vault;
   *  with `keep`, its folder here goes into `.removed/` instead. */
  async function forget(id: string, keep = false): Promise<void> {
    const l = live.get(id)
    if (l !== undefined) {
      for (const timer of [l.persistTimer, l.filesTimer, l.emitTimer]) {
        if (timer !== null) clearTimeout(timer)
      }
    }
    deleted.add(id)
    scribe.end(id, l?.stored.meeting.scribeSessionId)
    live.delete(id)
    summaries.delete(id)
    missing.delete(id)
    away.delete(id)
    // Machine state first: once it is gone the meeting is gone, even if a
    // vault file cannot be removed. A save already under way finishes
    // before the folder goes, so it cannot bring the meeting back.
    await saving.get(id)?.catch(() => {})
    const kept =
      keep &&
      (await mkdir(join(deps.dir, REMOVED), { recursive: true })
        .then(() => rename(dirOf(id), join(deps.dir, REMOVED, `${id}-${now()}`)))
        .then(
          () => true,
          () => false,
        ))
    if (!kept) await rm(dirOf(id), { recursive: true, force: true, maxRetries: 3 })
    emitList()
  }

  /** Whether the meeting's scribe may still hear something. */
  const scribeListens = (l: Live): boolean => {
    const m = l.stored.meeting
    return (
      !l.rescued &&
      m.scribeSessionId !== undefined &&
      (m.phase === 'recording' || m.phase === 'finishing')
    )
  }

  /** Whoever `drain` has waiting for a meeting to stop recording. */
  const stopped: Array<() => void> = []

  /** Meetings a person deleted: nothing of them is saved or written again. */
  const deleted = new Set<string>()
  /** Each meeting's save in flight, which a delete waits out. */
  const saving = new Map<string, Promise<void>>()

  async function persist(l: Live): Promise<void> {
    if (l.persistTimer !== null) clearTimeout(l.persistTimer)
    l.persistTimer = null
    await persistStored(l.stored)
  }

  /** Save a record, after any save of it already under way. */
  async function persistStored(stored: Stored): Promise<void> {
    const id = stored.meeting.id
    if (deleted.has(id)) return
    // The clone noted for it wins over a copy loaded before it was noted.
    const clone = cloneOf.get(id)
    if (clone !== undefined) stored.clone = clone
    const save = (async () => {
      await saving.get(id)?.catch(() => {})
      if (deleted.has(id)) return
      await mkdir(dirOf(id), { recursive: true })
      const path = join(dirOf(id), 'state.json')
      const tmp = `${path}.${randomBytes(3).toString('hex')}.tmp`
      await writeFile(tmp, JSON.stringify(stored), 'utf8')
      await rename(tmp, path)
    })()
    saving.set(id, save)
    try {
      await save
    } finally {
      if (saving.get(id) === save) saving.delete(id)
    }
  }

  const persistSoon = (l: Live) => {
    if (l.persistTimer !== null || disposed) return
    l.persistTimer = setTimeout(() => {
      l.persistTimer = null
      void persist(l).catch((err: unknown) =>
        deps.log('error', `meeting: could not save ${l.stored.meeting.id}: ${String(err)}`),
      )
    }, PERSIST_MS)
  }

  async function writeFiles(l: Live, adopt = false): Promise<void> {
    if (l.filesTimer !== null) clearTimeout(l.filesTimer)
    l.filesTimer = null
    if (deleted.has(l.stored.meeting.id)) return
    const { meeting, profile } = l.stored
    // Only into its own folder: one moved or deleted is not made again at
    // the old path, and another meeting's is never written over. Asked
    // again under each file's lock, which a vault move takes too.
    const own = () => mayWrite(l, adopt)
    if (!(await own())) {
      followSoon()
      return
    }
    const files: Array<[string, string]> = [
      [`${meeting.folder}/transcript.local.md`, transcriptMarkdown(meeting)],
    ]
    if (meeting.minutes.trim() !== '') {
      files.push([minutesFile(meeting.folder, profile), `${meeting.minutes.trimEnd()}\n`])
    }
    for (const [rel, text] of files) {
      if (l.written.get(rel) === text) continue
      try {
        // The transcript first, and the rest only beside one that is this
        // meeting's (after it is written, no longer the adoption's).
        const guard = rel.endsWith('/transcript.local.md') ? own : () => mayWrite(l)
        if ((await deps.writeFile(rel, text, guard)) === false) {
          followSoon()
          return
        }
        l.written.set(rel, text)
        if (rel.endsWith('/transcript.local.md') && l.stored.marked !== true) {
          l.stored.marked = true
          l.fresh = false
          persistSoon(l)
        }
        if (rel.endsWith('/transcript.local.md')) await noteClone(l.stored.meeting.id)
      } catch (err) {
        deps.log('error', `meeting: could not write ${rel}: ${String(err)}`)
      }
    }
  }

  const filesSoon = (l: Live) => {
    if (l.filesTimer !== null || disposed) return
    l.filesTimer = setTimeout(() => {
      l.filesTimer = null
      void writeFiles(l)
    }, FILES_MS)
  }

  function emitList(): void {
    const list = [...summaries.values()].sort((a, b) => b.startedAt - a.startedAt)
    const text = JSON.stringify(list)
    if (text === lastList) return
    lastList = text
    deps.emit('meetings', list)
  }

  function emitMeeting(l: Live): void {
    if (l.emitTimer !== null) return
    const wait = l.lastEmit + EMIT_MS - now()
    const send = () => {
      l.emitTimer = null
      l.lastEmit = now()
      deps.emit('meeting', l.stored.meeting)
    }
    if (wait <= 0) send()
    else l.emitTimer = setTimeout(send, wait)
  }

  /** Something about a meeting changed: save it, write its files, tell the
   *  renderer. */
  function changed(id: string): void {
    const l = live.get(id)
    if (l === undefined || disposed || deleted.has(id)) return
    const m = l.stored.meeting
    // Every change keeps the joins tidy: a group gone, closed or split
    // leaves no join pointing nowhere.
    m.topics = tidyJoins(m.topics)
    // A meeting saved before groups keeps the minutes its scribe wrote.
    if (m.topics.length > 0) m.minutes = renderMinutes(m, l.stored.profile.language)
    summaries.set(id, summarize(m))
    persistSoon(l)
    filesSoon(l)
    emitMeeting(l)
    emitList()
  }

  function liveOf(stored: Stored): Live {
    return {
      stored,
      received: new Map(),
      skip: new Set(),
      revived: new Set(),
      persistTimer: null,
      filesTimer: null,
      emitTimer: null,
      lastEmit: 0,
      written: new Map(),
      inflight: new Set(),
      flushed: [],
      parked: new Set(),
      rescued: false,
      fresh: false,
    }
  }

  async function readStored(id: string): Promise<Stored | null> {
    const text = await readFile(join(dirOf(id), 'state.json'), 'utf8').catch(() => null)
    if (text === null) return null
    try {
      const stored = JSON.parse(text) as Stored
      if (stored.version !== 1 || stored.remote !== deps.remote) return null
      // A meeting saved before it said where its minutes go.
      stored.meeting.minutesPath ??= minutesFile(stored.meeting.folder, stored.profile)
      // A meeting saved before groups, or before a group had every field.
      stored.meeting.topics = (stored.meeting.topics ?? []).map(normalTopic)
      return stored
    } catch {
      return null
    }
  }

  /** A meeting's default title: the time it started. */
  const defaultTitle = (at: number): string => {
    const d = new Date(at)
    return `Meeting ${pad(d.getHours())}.${pad(d.getMinutes())}`
  }

  /** A meeting folder for `name` in `parent` ('' the root) that no meeting
   *  and no file has: `<parent>/<date> <name>.meeting`, numbered when taken.
   *  The suffix makes the vault's tree open it as one document. */
  async function freeFolder(parent: string, name: string, at: number): Promise<string> {
    const d = new Date(at)
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const base = `${parent === '' ? '' : `${parent}/`}${day} ${folderTitle(name)}`
    let folder = `${base}${MEETING_SUFFIX}`
    const taken = new Set([...summaries.values()].map((s) => s.folder))
    for (let k = 2; taken.has(folder) || (await exists(join(deps.root, folder))); k++) {
      folder = `${base} (${k})${MEETING_SUFFIX}`
    }
    return folder
  }

  /** Each older meeting's read from disk while it is under way: callers
   *  share it, so two cannot each load a copy and the later one replace an
   *  edit already made to the first. */
  const loading = new Map<string, Promise<Live>>()

  /** A meeting in memory, read from disk when it is an older one. */
  function open(id: string): Promise<Live> {
    const known = live.get(id)
    if (known !== undefined) return Promise.resolve(known)
    const pending = loading.get(id)
    if (pending !== undefined) return pending
    if (!/^[0-9a-f]{12}$/.test(id) || !summaries.has(id)) {
      return Promise.reject(new CapabilityError('NOT_FOUND', `no meeting ${id}`))
    }
    const load = (async () => {
      const stored = await readStored(id)
      if (stored === null || deleted.has(id)) {
        throw new CapabilityError('NOT_FOUND', `no meeting ${id}`)
      }
      const l = live.get(id) ?? liveOf(stored)
      live.set(id, l)
      return l
    })().finally(() => loading.delete(id))
    loading.set(id, load)
    return load
  }

  // --- uploads ---------------------------------------------------------------

  function enqueue(id: string, n: number): void {
    if (queue.some((q) => q.id === id && q.n === n)) return
    queue.push({ id, n })
    pump()
  }

  function pump(): void {
    while (!disposed && active < CONCURRENCY && queue.length > 0) {
      const job = queue.shift()!
      active++
      live.get(job.id)?.inflight.add(job.n)
      void upload(job.id, job.n).finally(() => {
        active--
        live.get(job.id)?.inflight.delete(job.n)
        settled(job.id)
        pump()
      })
    }
  }

  /** Wake whoever waits for the meeting's uploads once none is left. */
  function settled(id: string): void {
    const l = live.get(id)
    if (l === undefined) return
    const busy =
      l.inflight.size > 0 ||
      l.stored.meeting.chunks.some((c) => c.state === 'queued' || c.state === 'uploading')
    if (busy) return
    for (const resolve of l.flushed.splice(0)) resolve()
  }

  function retryLater(id: string, n: number, ms: number): void {
    const timer = setTimeout(() => {
      retryTimers.delete(timer)
      enqueue(id, n)
    }, ms)
    retryTimers.add(timer)
  }

  async function upload(id: string, n: number): Promise<void> {
    const l = live.get(id)
    const chunk = l?.stored.meeting.chunks.find((c) => c.n === n)
    if (l === undefined || chunk === undefined || chunk.state === 'done') return
    const { meeting, profile } = l.stored
    const epoch = keyEpoch
    // The key for the very service the chunk goes to: read apart, a service
    // changed between the two would get the other's key.
    const service = await deps.service().catch(() => SYV_SERVICE)
    const apiKey = await deps.apiKey(service).catch(() => null)
    if (disposed) return
    // syv.ai's service needs a key; another may take requests without.
    const missing = isSyv(service) && (apiKey === null || apiKey === '')
    if (missing || (apiKey !== null && apiKey === badKey)) {
      if (epoch !== keyEpoch) enqueue(id, n)
      else park(l, chunk, missing ? 'no-key' : 'bad-key')
      return
    }
    chunk.state = 'uploading'
    chunk.tries++
    changed(id)
    let pcm: Pcm
    try {
      pcm = parseWav(new Uint8Array(await readFile(wavOf(id, n))))
    } catch (err) {
      // Audio that cannot be read will not read better later.
      chunk.state = 'failed'
      chunk.error = err instanceof Error ? err.message : String(err)
      l.skip.add(n)
      restitch(l, false)
      changed(id)
      return
    }
    try {
      const ask = (wav: Uint8Array) =>
        transcribe(deps.fetch, {
          service,
          wav,
          apiKey,
          // A profile's speech model is one of syv.ai's: another service
          // is asked for the model it was set up with.
          model: isSyv(service) ? (profile.asrModel ?? DEFAULT_ASR_MODEL) : (service.model ?? ''),
          language: profile.language,
          diarize: profile.roomDiarize === true,
          vocab: profile.glossary.map((g) => g.term),
          duration: chunk.duration,
        })
      const roomDiarize = profile.roomDiarize === true
      const segments = await transcribeChunk({ pcm, chunk, roomDiarize, vad: deps.vad, ask })
      if (disposed) return
      l.stored.pending[n] = segments
      chunk.state = 'done'
      delete chunk.error
      const received = l.received.get(n)
      if (received !== undefined) chunk.latencyMs = now() - received
      restitch(l, false)
      // The transcript is safe on disk before the audio goes.
      await persist(l)
      if (!profile.keepAudio) await rm(wavOf(id, n), { force: true })
      changed(id)
      if (!l.rescued) scribe.feed(id)
      // A key works: what waited for one goes.
      release()
      // The service answers again: what failed before may go through now.
      // Once: a chunk that fails again waits for the stop.
      for (const c of meeting.chunks) {
        if (c.state === 'failed' && !l.skip.has(c.n) && !l.revived.has(c.n)) {
          l.revived.add(c.n)
          c.state = 'queued'
          c.tries = 0
          enqueue(id, c.n)
        }
      }
    } catch (err) {
      if (disposed) return
      if (keyRefused(err)) {
        if (epoch !== keyEpoch) {
          // Refused a key that has since changed: the new one gets its turn.
          chunk.state = 'queued'
          chunk.tries = 0
          changed(id)
          enqueue(id, n)
          return
        }
        // No retry fixes a refused key; a new key does.
        badKey = apiKey
        park(l, chunk, 'bad-key')
        return
      }
      chunk.error = err instanceof Error ? err.message : String(err)
      const wait = UPLOAD_RETRY_MS[chunk.tries - 1]
      if (wait === undefined) {
        chunk.state = 'failed'
        deps.log('warn', `meeting "${meeting.title}": chunk ${n} failed: ${chunk.error}`)
        if (meeting.phase === 'finishing') {
          // Tried again since the stop: the transcript goes on without it.
          l.skip.add(n)
          restitch(l, false)
        }
      } else {
        chunk.state = 'queued'
        retryLater(id, n, wait)
      }
      changed(id)
    }
  }

  /** Hold a chunk, queued and untried, until the key changes. Its error is
   *  Holi's own words: the service's answer to a refused key is not shown. */
  function park(l: Live, chunk: ChunkInfo, why: MeetingBlock): void {
    chunk.state = 'queued'
    chunk.tries = 0
    chunk.error = why === 'no-key' ? NO_KEY : BAD_KEY
    l.parked.add(chunk.n)
    l.stored.meeting.blocked = why
    changed(l.stored.meeting.id)
  }

  /** Send every parked chunk again, in order. */
  function release(): void {
    for (const l of live.values()) {
      const { meeting } = l.stored
      if (l.parked.size === 0 && meeting.blocked === undefined) continue
      const parked = [...l.parked].sort((a, b) => a - b)
      l.parked.clear()
      delete meeting.blocked
      for (const n of parked) {
        const c = meeting.chunks.find((x) => x.n === n)
        if (c?.state !== 'queued') continue
        delete c.error
        enqueue(meeting.id, n)
      }
      changed(meeting.id)
    }
  }

  function restitch(l: Live, final: boolean): void {
    const { meeting } = l.stored
    const result = stitch(
      { segments: meeting.segments, next: l.stored.next, pending: l.stored.pending },
      { skip: l.skip, final },
    )
    meeting.segments = result.state.segments
    // New lines belong to what is being talked about now.
    meeting.topics = extendTopics(meeting.topics, meeting.segments)
    l.stored.next = result.state.next
    l.stored.pending = result.state.pending
    for (const { segment: s, reason } of result.dropped) {
      const text = s.text.length > 80 ? `${s.text.slice(0, 80)}…` : s.text
      deps.log(
        'debug',
        `meeting ${meeting.id}: dropped ${s.speaker} at ${s.start.toFixed(1)}s (${reason}): ${JSON.stringify(text)}`,
      )
    }
  }

  // --- the end of a meeting --------------------------------------------------

  async function finish(id: string): Promise<void> {
    const l = live.get(id)
    if (l === undefined) return
    const { meeting } = l.stored
    // What failed is tried once more, from the start of its backoff; a
    // rescued meeting tried what it could when it was rescued.
    for (const c of meeting.chunks) {
      if (c.state === 'failed' && !l.rescued && c.error !== LOST) {
        c.state = 'queued'
        c.tries = 0
        enqueue(id, c.n)
      }
    }
    await new Promise<void>((resolve) => {
      l.flushed.push(resolve)
      settled(id)
    })
    if (disposed) return
    for (const c of meeting.chunks) if (c.state === 'failed') l.skip.add(c.n)
    restitch(l, true)
    changed(id)
    await writeFiles(l)
    // The final pass gets its whole time from here, once every upload is
    // done: slow transcription, or a wait for the key, is not the scribe's.
    const deadline = now() + FINISH_MS
    if (!l.rescued) await scribe.finish(id, deadline)
    if (disposed) return
    // The last group closes with the meeting: after the final pass, which
    // may still cut it.
    meeting.topics = closeTopics(meeting.topics)
    meeting.phase =
      meeting.chunks.length > 0 && meeting.chunks.every((c) => c.state === 'failed')
        ? 'failed'
        : 'done'
    changed(id)
    await persist(l)
    await writeFiles(l)
  }

  // --- the scribe's verbs ----------------------------------------------------

  function scribing(session: string): { meeting: MeetingState; profile: MeetingProfile } {
    for (const l of live.values()) {
      const m = l.stored.meeting
      if (m.scribeSessionId === session && (m.phase === 'recording' || m.phase === 'finishing')) {
        return { meeting: m, profile: l.stored.profile }
      }
    }
    throw new CapabilityError(
      'FORBIDDEN',
      'only the scribe of a meeting that is running may do this',
      'this command is for the meeting scribe session Holi started; do not retry',
    )
  }

  const specOf = (l: Live, card: Card, context?: string) => {
    const { meeting, profile } = l.stored
    const group = meeting.topics.find((t) => t.id === card.from?.topicId)
    return {
      meetingTitle: meeting.title,
      startedAt: meeting.startedAt,
      minutesPath: minutesFile(meeting.folder, profile),
      ...(context === undefined ? {} : { context }),
      ...(group === undefined || group.title === ''
        ? {}
        : {
            group: {
              title: group.title,
              summary: group.summary,
              start: group.start,
              end: group.end,
            },
          }),
    }
  }

  async function ensureTask(l: Live, card: Card, context?: string): Promise<string> {
    if (card.taskPath !== undefined) return card.taskPath
    const { path } = await deps.agent.createTask({
      title: card.title,
      folder: l.stored.meeting.folder,
      description: cardSpec(card, specOf(l, card, context)),
    })
    return path
  }

  /** The card's task, saying what the card says now: made if it is not yet,
   *  else its text written again from the card a person may have edited
   *  since. A task that cannot be written is not sent: a Holi reads the file
   *  as its instructions, and would carry out what it said before. */
  async function sendableTask(l: Live, card: Card, context?: string): Promise<string> {
    if (card.taskPath === undefined) return ensureTask(l, card, context)
    try {
      await deps.agent.updateTask({
        path: card.taskPath,
        description: cardSpec(card, specOf(l, card, context)),
      })
    } catch (err) {
      deps.log('warn', `meeting: could not update the task ${card.taskPath}: ${String(err)}`)
      throw new CapabilityError(
        'UNAVAILABLE',
        `the task’s file could not be updated, so nothing was sent: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return card.taskPath
  }

  /** The ids of suggestions a person sent: kept if the scribe drops them. */
  const sentSuggestions = (meeting: MeetingState): Set<string> =>
    new Set(
      meeting.cards.flatMap((c) =>
        c.from?.suggestionId === undefined ? [] : [c.from.suggestionId],
      ),
    )

  const topicOf = (meeting: MeetingState, groupId: string): number => {
    const at = meeting.topics.findIndex((t) => t.id === groupId)
    if (at < 0) throw new CapabilityError('NOT_FOUND', `no group ${groupId}`)
    return at
  }

  const cardOf = (l: Live, cardId: string): number => {
    const at = l.stored.meeting.cards.findIndex((c) => c.id === cardId)
    if (at < 0) throw new CapabilityError('NOT_FOUND', `no card ${cardId}`)
    return at
  }

  /** A person's correction of the line at `at`: quoted where it is cited,
   *  and told to the scribe if it has read the line already or it is in the
   *  batch on its way, which carries the old words (one it has not reaches
   *  it as it now reads). */
  function correct(l: Live, at: number, text: string): Segment {
    const { meeting } = l.stored
    const seg = meeting.segments[at]!
    const edited: Segment = { ...seg, text, edited: true }
    meeting.segments[at] = edited
    requote(meeting, seg.i, now())
    if (scribeListens(l) && seg.i <= scribe.through(meeting.id)) {
      notesOf(l).corrections[seg.i] = text
      scribe.feed(meeting.id)
    }
    return edited
  }

  /**
   * A sent task, run by the vault's chosen agent: Claude Code as a background
   * session with the profile's model and MCP config (Claude Code's alone),
   * Pi as its background run, and any other in a session of its own that
   * the person watches. Whatever the agent cannot do it says, as the error;
   * it never falls back to another agent.
   */
  async function runOnAgent(
    name: string,
    prompt: string,
    profile: MeetingProfile,
  ): Promise<string> {
    const provider = await deps.provider()
    const res =
      provider === 'claude'
        ? await deps.agent.launch({
            name,
            prompt,
            ...(profile.buildModel === undefined ? {} : { model: profile.buildModel }),
            ...(profile.mcpConfig === undefined ? {} : { mcpConfig: profile.mcpConfig }),
          })
        : provider === 'pi'
          ? await deps.agent.launch({ name, prompt, provider })
          : await deps.agent.start({ name, prompt, provider })
    if (!res.ok) throw new CapabilityError('UNAVAILABLE', res.message)
    return res.sessionId
  }

  /** Cards being sent, by meeting and card: one send at a time each, from
   *  whichever panel or caller, so two cannot both make a task or start a
   *  run. */
  const sends = new Set<string>()

  async function send(
    meetingId: string,
    cardId: string,
    opts: SendOptions,
  ): Promise<{ sessionId: string }> {
    const l = await open(meetingId)
    const { meeting, profile } = l.stored
    const at = cardOf(l, cardId)
    const before = meeting.cards[at]!
    if (before.status === 'building' && before.buildSessionId !== undefined) {
      throw new CapabilityError('CONFLICT', 'this card was sent already')
    }
    const { context } = opts
    const target: SendTarget = opts.target ?? { kind: 'agent' }
    const taskPath = await sendableTask(l, before, context)
    const card: Card = { ...meeting.cards[at]!, taskPath }
    meeting.cards[at] = card
    changed(meetingId)
    let sessionId: string
    if (target.kind === 'holi') {
      // The Holi reads its work from the document it is sent: the task,
      // which now says how the person wants it done.
      ;({ sessionId } = await deps.agent.sendToHoli({ holi: target.id, path: taskPath }))
    } else {
      sessionId = await runOnAgent(
        `${card.kind === 'action' ? 'Action' : 'Build'} · ${card.title}`,
        buildBrief(card, { ...specOf(l, card, context), taskPath, profile }),
        profile,
      )
    }
    const building: Card = {
      ...meeting.cards[at]!,
      status: 'building',
      buildSessionId: sessionId,
      target,
      updatedAt: now(),
    }
    meeting.cards[at] = building
    changed(meetingId)
    return { sessionId }
  }

  const api: Meetings = {
    async load() {
      await mkdir(deps.dir, { recursive: true })
      await purgeRemoved()
      cloneId = await loadClone()
      const ids = (await readdir(deps.dir).catch(() => [] as string[])).filter((id) =>
        /^[0-9a-f]{12}$/.test(id),
      )
      for (const id of ids) {
        const stored = await readStored(id)
        if (stored === null) continue
        summaries.set(id, summarize(stored.meeting))
        cloneOf.set(id, stored.clone)
        const m = stored.meeting
        if (m.phase === 'recording' || m.phase === 'finishing') {
          const l = liveOf(stored)
          live.set(id, l)
          await recover(l)
        } else {
          await rescue(stored)
        }
      }
      emitList()
    },

    async prepare({ folder: parent, title }) {
      const name = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
      const path = await freeFolder(parent, name === '' ? defaultTitle(now()) : name, now())
      await deps.writeFile(
        `${path}/transcript.local.md`,
        `${PLACEHOLDER_HEAD}# ${name === '' ? 'Meeting' : name}\n\n${NOT_RECORDED}\n`,
      )
      return { path }
    },

    async start({ title, profileId, folder: parent = DEFAULT_PARENT, path }) {
      const profile =
        profileId === undefined
          ? ((await deps.profiles.list())[0] ?? DEFAULT_PROFILE)
          : await deps.profiles.get(profileId)
      const at = now()
      const name = title?.trim() || defaultTitle(at)
      // A folder is a meeting's by the id in its transcript, not by a record
      // that once had its path: that meeting moved or was deleted.
      const there = path === undefined ? null : (await markAt(path)).kind
      if (there === 'meeting') {
        throw new CapabilityError('CONFLICT', 'that folder has a meeting already')
      }
      // A transcript with no meeting's id is a file someone put there.
      if (there === 'unmarked') {
        throw new CapabilityError('CONFLICT', 'that folder holds a transcript of its own')
      }
      const folder = path ?? (await freeFolder(parent, name, at))
      const id = randomBytes(6).toString('hex')
      const meeting: MeetingState = {
        id,
        title: name,
        profileId: profile.id,
        startedAt: at,
        phase: 'recording',
        segments: [],
        minutes: '',
        cards: [],
        topics: [],
        scribeState: 'off',
        scribeCursor: -1,
        chunks: [],
        folder,
        minutesPath: minutesFile(folder, profile),
      }
      const l = liveOf({ version: 1, remote: deps.remote, meeting, profile, next: 0, pending: {} })
      l.fresh = true
      live.set(id, l)
      await persist(l)
      // Its transcript, with its id, at once: the folder is this meeting's
      // from the start, so no other can be started in it.
      await writeFiles(l)
      changed(id)
      void scribe.launch(id)
      return { meetingId: id }
    },

    async chunk({ meetingId, n, start, duration, audio }) {
      const l = await open(meetingId)
      const { meeting } = l.stored
      if (meeting.phase !== 'recording') {
        throw new CapabilityError('CONFLICT', 'this meeting is not recording')
      }
      if (meeting.chunks.some((c) => c.n === n)) {
        throw new CapabilityError('CONFLICT', `chunk ${n} is already in`)
      }
      if (audio.byteLength > MAX_CHUNK_BYTES) {
        throw new CapabilityError('BAD_REQUEST', 'the chunk is too large')
      }
      // On disk first: whatever happens next, the audio is kept.
      await mkdir(dirOf(meetingId), { recursive: true })
      await writeFile(wavOf(meetingId, n), audio)
      l.received.set(n, now())
      const info: ChunkInfo = { n, start, duration, state: 'queued', tries: 0 }
      meeting.chunks.push(info)
      meeting.chunks.sort((a, b) => a.n - b.n)
      await persist(l)
      changed(meetingId)
      enqueue(meetingId, n)
    },

    async lose({ meetingId, n, start, duration }) {
      const l = await open(meetingId)
      const { meeting } = l.stored
      // It got through after all, or the meeting is long over.
      if (meeting.chunks.some((c) => c.n === n)) return
      if (meeting.phase !== 'recording' && meeting.phase !== 'finishing') return
      meeting.chunks.push({ n, start, duration, state: 'failed', tries: 0, error: LOST })
      meeting.chunks.sort((a, b) => a.n - b.n)
      l.skip.add(n)
      restitch(l, false)
      deps.log('warn', `meeting "${meeting.title}": chunk ${n} never reached Holi`)
      changed(meetingId)
      await persist(l)
      if (!l.rescued) scribe.feed(meetingId)
      settled(meetingId)
    },

    async stop(meetingId) {
      const l = await open(meetingId)
      const { meeting } = l.stored
      if (meeting.phase !== 'recording') return
      meeting.phase = 'finishing'
      meeting.endedAt = now()
      for (const resolve of stopped.splice(0)) resolve()
      changed(meetingId)
      await persist(l)
      void finish(meetingId).catch((err: unknown) =>
        deps.log('error', `meeting "${meeting.title}": could not finish: ${String(err)}`),
      )
    },

    async drain(ms) {
      const recording = () => [...live.values()].some((l) => l.stored.meeting.phase === 'recording')
      if (!recording()) return
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))
      const quiet = (async () => {
        while (recording()) await new Promise<void>((resolve) => stopped.push(resolve))
      })()
      await Promise.race([late, quiet])
      clearTimeout(timer)
      for (const resolve of stopped.splice(0)) resolve()
    },

    get: async (meetingId) => (await open(meetingId)).stored.meeting,

    list: () => [...summaries.values()].sort((a, b) => b.startedAt - a.startedAt),

    async rename(meetingId, title) {
      const l = await open(meetingId)
      const name = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
      if (name === '') throw new CapabilityError('BAD_REQUEST', 'a meeting needs a title')
      l.stored.meeting.title = name
      changed(meetingId)
      return summarize(l.stored.meeting)
    },

    async remove(meetingId) {
      const l = await open(meetingId)
      const m = l.stored.meeting
      if (m.phase === 'recording' || m.phase === 'finishing') {
        throw new CapabilityError('CONFLICT', 'stop the meeting before deleting it')
      }
      await forget(meetingId)
      const files = new Set([
        `${m.folder}/transcript.local.md`,
        `${m.folder}/minutes.local.md`,
        `${m.folder}/minutes.md`,
      ])
      try {
        await deps.removeFiles([...files], m.folder)
      } catch (err) {
        deps.log('warn', `meeting "${m.title}": could not remove its files: ${String(err)}`)
      }
    },

    async patchCard(meetingId, cardId, patch) {
      const l = await open(meetingId)
      const cards = l.stored.meeting.cards
      const at = cardOf(l, cardId)
      let card = applyPatch(cards[at]!, patch, now())
      if (patch.status === 'accepted' && card.taskPath === undefined) {
        card = { ...card, taskPath: await ensureTask(l, card) }
      }
      cards[at] = card
      changed(meetingId)
      return card
    },

    async build(meetingId, cardId, opts = {}) {
      const key = `${meetingId}/${cardId}`
      if (sends.has(key)) throw new CapabilityError('CONFLICT', 'this card is being sent')
      sends.add(key)
      try {
        return await send(meetingId, cardId, opts)
      } finally {
        sends.delete(key)
      }
    },

    async editSegment(meetingId, i, text) {
      const l = await open(meetingId)
      const { meeting } = l.stored
      const at = meeting.segments[i]?.i === i ? i : meeting.segments.findIndex((s) => s.i === i)
      const seg = meeting.segments[at]
      if (seg === undefined) throw new CapabilityError('NOT_FOUND', `no line ${i} in this meeting`)
      if (seg.text === text) return seg
      const edited = correct(l, at, text)
      changed(meetingId)
      await writeFiles(l)
      return edited
    },

    async replaceText(meetingId, find, replacement, all) {
      const l = await open(meetingId)
      const { meeting } = l.stored
      const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), all ? 'gi' : 'i')
      const edited: Segment[] = []
      for (let at = 0; at < meeting.segments.length; at++) {
        const seg = meeting.segments[at]!
        if (!pattern.test(seg.text)) continue
        pattern.lastIndex = 0
        const text = seg.text
          .replace(pattern, () => replacement)
          .replace(/\s+/g, ' ')
          .trim()
        if (text === '' || text === seg.text) continue
        edited.push(correct(l, at, text))
        if (!all) break
      }
      if (edited.length > 0) {
        changed(meetingId)
        await writeFiles(l)
      }
      return edited
    },

    async exportMinutes(meetingId, out) {
      const { meeting } = (await open(meetingId)).stored
      if (!isAbsolute(out) || !/\.md$/i.test(out)) {
        throw new CapabilityError('BAD_REQUEST', 'the minutes go to an absolute path ending in .md')
      }
      if (await isSymlink(out)) throw new CapabilityError('BAD_REQUEST', `${out} is a symlink`)
      const day = new Date(meeting.startedAt)
      const date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
      // Minutes rendered from groups carry their title and date; a meeting's
      // from before them does not.
      const text = meeting.minutes.startsWith('# ')
        ? `${meeting.minutes.trim()}\n`
        : `# ${meeting.title}\n\n${date}\n\n${meeting.minutes.trim()}\n`
      // The dialog may answer with the vault's real path (`/private/var` for
      // `/var`): either names the vault.
      const within = (root: string): string | null => {
        const rel = relative(root, out)
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null
      }
      const rel = within(deps.root) ?? within(await realpath(deps.root).catch(() => deps.root))
      if (rel !== null) {
        // In the vault, the way every main-side writer writes a vault file.
        const vaultPath = rel.split(sep).join('/')
        await deps.writeFile(vaultPath, text)
        return { path: out, vaultPath }
      }
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, text, 'utf8')
      return { path: out, vaultPath: null }
    },

    async tell(meetingId, text, kind) {
      await open(meetingId)
      await scribe.tell(meetingId, text, kind)
    },

    async restartScribe(meetingId) {
      const l = await open(meetingId)
      const m = l.stored.meeting
      if (m.phase !== 'recording') {
        throw new CapabilityError('CONFLICT', 'this meeting is not recording')
      }
      if (m.scribeState !== 'gone' && m.scribeState !== 'off') {
        throw new CapabilityError('CONFLICT', 'the assistant is running')
      }
      delete m.scribeSessionId
      delete m.scribeUnreachable
      // A new session knows nothing yet: its first batch is the whole meeting.
      m.scribeCursor = -1
      changed(meetingId)
      await scribe.launch(meetingId)
    },

    async summarise(meetingId) {
      const l = await open(meetingId)
      const { meeting } = l.stored
      if (
        !scribeListens(l) ||
        meeting.phase !== 'recording' ||
        meeting.scribeState === 'gone' ||
        meeting.scribeState === 'off'
      ) {
        throw new CapabilityError('UNAVAILABLE', 'this meeting has no scribe running')
      }
      scribe.summarise(meetingId)
    },

    async createTask(meetingId, req) {
      const l = await open(meetingId)
      const { meeting } = l.stored
      if (req.cardId !== undefined && sends.has(`${meetingId}/${req.cardId}`)) {
        throw new CapabilityError('CONFLICT', 'this task is being sent')
      }
      const card = taskCard(meeting, req, now())
      if (scribeListens(l) && req.cardId === undefined) {
        const notes = notesOf(l)
        notes.tasks = [
          ...(notes.tasks ?? []),
          { id: card.id, title: card.title, start: card.range!.start, end: card.range!.end },
        ]
        scribe.feed(meetingId)
      }
      changed(meetingId)
      return card
    },

    async related(meetingId, query, exclude) {
      const { meeting } = (await open(meetingId)).stored
      return relatedWindows(meeting.segments, query, new Set(exclude))
    },

    async splitGroup(meetingId, i) {
      const { meeting } = (await open(meetingId)).stored
      meeting.topics = splitTopic(meeting.topics, meeting.segments, i)
      changed(meetingId)
      return meeting.topics
    },

    async mergeGroup(meetingId, groupId) {
      const { meeting } = (await open(meetingId)).stored
      meeting.topics = mergeTopic(meeting.topics, meeting.segments, groupId)
      changed(meetingId)
      return meeting.topics
    },

    async joinGroup(meetingId, groupId, into) {
      const { meeting } = (await open(meetingId)).stored
      meeting.topics = joinTopic(meeting.topics, groupId, into)
      changed(meetingId)
      return meeting.topics
    },

    async separateGroup(meetingId, groupId) {
      const { meeting } = (await open(meetingId)).stored
      meeting.topics = separateTopic(meeting.topics, groupId)
      changed(meetingId)
      return meeting.topics
    },

    async editGroup(meetingId, groupId, patch) {
      const l = await open(meetingId)
      const { meeting } = l.stored
      const at = topicOf(meeting, groupId)
      const topic = editTopic(meeting.topics[at]!, patch, now())
      meeting.topics[at] = topic
      if (scribeListens(l)) {
        const notes = notesOf(l)
        notes.edits = [...new Set([...(notes.edits ?? []), groupId])]
      }
      changed(meetingId)
      await writeFiles(l)
      return topic
    },

    scribing,

    async group(session, json) {
      const { meeting } = scribing(session)
      const input = parseGroup(json)
      const { topics, topic, kept } = applyGroup(meeting.topics, meeting.segments, input, {
        cursor: meeting.scribeCursor,
        sent: sentSuggestions(meeting),
      })
      meeting.topics = topics
      meeting.minutesAt = now()
      changed(meeting.id)
      return { topic, kept }
    },

    scribe,

    wake() {
      badKey = null
      keyEpoch++
      release()
    },

    follow,

    async dispose() {
      disposed = true
      if (followTimer !== null) clearTimeout(followTimer)
      scribe.dispose()
      for (const timer of retryTimers) clearTimeout(timer)
      queue.length = 0
      // What was waiting to be saved is saved before the disposer returns, so
      // quitting cannot land between the last change and its write.
      const saves = [...live.values()].map((l) => {
        for (const t of [l.persistTimer, l.filesTimer, l.emitTimer]) if (t !== null) clearTimeout(t)
        return persist(l).catch(() => {})
      })
      await Promise.all(saves)
    },
  }
  return api

  /** Let the transcript take chunks again from the first of `open`, which
   *  it had stitched past: a chunk before it is already in, and a done one
   *  after it with nothing pending adds nothing. New lines are numbered
   *  after the last, so no line a card cites changes number. */
  function rewind(l: Live, open: readonly number[]): void {
    const from = Math.min(...open)
    if (!(from < l.stored.next)) return
    for (const c of l.stored.meeting.chunks) {
      if (c.n >= from && c.state === 'done' && l.stored.pending[c.n] === undefined) l.skip.add(c.n)
    }
    l.stored.next = from
  }

  /** A meeting that ended done or failed with chunks that failed for the key
   *  alone, their audio still on disk: those chunks are sent again (they
   *  wait if there is still no key) and the meeting finishes again, without
   *  its scribe. */
  async function rescue(stored: Stored): Promise<void> {
    const { meeting } = stored
    const id = meeting.id
    const again: ChunkInfo[] = []
    for (const c of meeting.chunks) {
      if (keyFailure(c) && (await exists(wavOf(id, c.n)))) again.push(c)
    }
    if (again.length === 0) return
    const l = liveOf(stored)
    l.rescued = true
    live.set(id, l)
    delete meeting.blocked
    for (const c of meeting.chunks) {
      if (c.state === 'failed' && !again.includes(c)) l.skip.add(c.n)
    }
    rewind(
      l,
      again.map((c) => c.n),
    )
    for (const c of again) {
      c.state = 'queued'
      c.tries = 0
      enqueue(id, c.n)
    }
    meeting.phase = 'finishing'
    deps.log('info', `meeting "${meeting.title}": transcribing ${again.length} chunks again`)
    changed(id)
    void finish(id).catch((err: unknown) =>
      deps.log('error', `meeting "${meeting.title}": could not finish: ${String(err)}`),
    )
  }

  /** A meeting found recording or finishing at startup: every chunk on disk
   *  is uploaded, then it finishes. */
  async function recover(l: Live): Promise<void> {
    const { meeting } = l.stored
    // Asked again: the key may have come while Holi was closed.
    delete meeting.blocked
    const files = await readdir(dirOf(meeting.id)).catch(() => [] as string[])
    for (const file of files) {
      const n = Number(/^chunk-(\d+)\.wav$/.exec(file)?.[1] ?? NaN)
      if (!Number.isInteger(n) || meeting.chunks.some((c) => c.n === n)) continue
      // Written, but the crash came before its state was saved.
      const seconds = wavSeconds(new Uint8Array(await readFile(join(dirOf(meeting.id), file))))
      if (seconds === null) continue
      const start = Math.max(0, ...meeting.chunks.map((c) => c.start + c.duration))
      meeting.chunks.push({ n, start, duration: seconds, state: 'queued', tries: 0 })
    }
    meeting.chunks.sort((a, b) => a.n - b.n)
    // Chunks given up on before the restart are tried again at the finish:
    // the transcript must still be able to take them.
    const open = meeting.chunks.filter((c) => c.state !== 'done').map((c) => c.n)
    if (open.length > 0) rewind(l, open)
    for (const c of meeting.chunks) {
      if (c.state === 'queued' || c.state === 'uploading') {
        c.state = 'queued'
        enqueue(meeting.id, c.n)
      }
    }
    if (meeting.phase === 'recording') {
      meeting.phase = 'finishing'
      meeting.endedAt = meeting.endedAt ?? now()
    }
    changed(meeting.id)
    void finish(meeting.id).catch((err: unknown) =>
      deps.log('error', `meeting "${meeting.title}": could not finish: ${String(err)}`),
    )
  }
}

/** Whether `path` itself is a symlink (absent is not): a write would land
 *  wherever it points. */
async function isSymlink(path: string): Promise<boolean> {
  return lstat(path).then(
    (s) => s.isSymbolicLink(),
    () => false,
  )
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}
