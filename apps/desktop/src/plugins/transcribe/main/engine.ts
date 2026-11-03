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
  Topic,
  TopicField,
} from '../shared/meeting'
import { tidyJoins } from '../shared/joins'
import { speakerName } from '../shared/meeting'
import { clock } from '../shared/scribe-prompt'
import { keyRefused, transcribe, type Fetch } from './asr'
import { buildBrief, cardSpec } from './build'
import { applyPatch, requote, taskCard, type CardPatch, type TaskRequest } from './cards'
import { renderMinutes } from './minutes'
import { DEFAULT_ASR_MODEL, type Profiles } from './profiles'
import { relatedWindows, type Related } from './related'
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
  /** When the meeting last stopped waiting for the key: a final pass gets
   *  its full time from then. */
  unblockedAt: number
  /** Finished again after it ended (`rescue`): its scribe is gone and is
   *  not started again. */
  rescued: boolean
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
  /** Claude, unless a Holi is named. */
  target?: SendTarget
}

export interface MeetingsDeps {
  /** `userData/meetings`. */
  dir: string
  remote: string
  /** The vault clone. */
  root: string
  profiles: Pick<Profiles, 'get'>
  fetch: Fetch
  /** The speech key in use (`speech-key.ts`), or null. */
  apiKey(): Promise<string | null>
  /** Write a vault file (`vault-write.ts`). */
  writeFile(rel: string, text: string): Promise<void>
  /** Remove vault files, then `folder` if nothing else is left in it. */
  removeFiles(rels: readonly string[], folder: string): Promise<void>
  emit(name: 'meeting' | 'meetings', payload: unknown): void
  agent: AgentCalls & TaskCalls & HoliCalls
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  now?: () => number
  /** Voice detection before upload (`vad.ts`); absent, chunks go up whole. */
  vad?: ChunkVad
}

export interface Meetings {
  /** Read this vault's meetings from disk and pick up any left unfinished. */
  load(): Promise<void>
  start(args: { title?: string; profileId: string }): Promise<{ meetingId: string }>
  chunk(args: {
    meetingId: string
    n: number
    start: number
    duration: number
    audio: Uint8Array
  }): Promise<void>
  stop(meetingId: string): Promise<void>
  get(meetingId: string): Promise<MeetingState>
  list(): MeetingSummary[]
  /** A person renames a meeting: its title, not its folder. */
  rename(meetingId: string, title: string): Promise<MeetingSummary>
  /** A person deletes a finished meeting: its state on this machine and the
   *  transcript and minutes it wrote; the tasks made from it stay. */
  remove(meetingId: string): Promise<void>
  patchCard(meetingId: string, cardId: string, patch: CardPatch): Promise<Card>
  /** Send a card to an agent: a Claude session, or a Holi. */
  build(meetingId: string, cardId: string, opts?: SendOptions): Promise<{ sessionId: string }>
  /** A person's word to the scribe: a note, or a change to the groups. */
  tell(meetingId: string, text: string, kind?: TellKind): Promise<void>
  /** The person pressed Summarise now: the scribe's next batch goes as soon
   *  as it is idle. */
  summarise(meetingId: string): Promise<void>
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
  const wavOf = (id: string, n: number) => join(dirOf(id), `chunk-${n}.wav`)

  const scribe = createScribe({
    agent: deps.agent,
    log: deps.log,
    now,
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

  /** Whether the meeting's scribe may still hear something. */
  const scribeListens = (l: Live): boolean => {
    const m = l.stored.meeting
    return (
      !l.rescued &&
      m.scribeSessionId !== undefined &&
      (m.phase === 'recording' || m.phase === 'finishing')
    )
  }

  /** Meetings a person deleted: nothing of them is saved or written again. */
  const deleted = new Set<string>()
  /** Each meeting's save in flight, which a delete waits out. */
  const saving = new Map<string, Promise<void>>()

  async function persist(l: Live): Promise<void> {
    if (l.persistTimer !== null) clearTimeout(l.persistTimer)
    l.persistTimer = null
    const id = l.stored.meeting.id
    if (deleted.has(id)) return
    const save = (async () => {
      await saving.get(id)?.catch(() => {})
      if (deleted.has(id)) return
      await mkdir(dirOf(id), { recursive: true })
      const path = join(dirOf(id), 'state.json')
      const tmp = `${path}.${randomBytes(3).toString('hex')}.tmp`
      await writeFile(tmp, JSON.stringify(l.stored), 'utf8')
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

  async function writeFiles(l: Live): Promise<void> {
    if (l.filesTimer !== null) clearTimeout(l.filesTimer)
    l.filesTimer = null
    if (deleted.has(l.stored.meeting.id)) return
    const { meeting, profile } = l.stored
    const files: Array<[string, string]> = [
      [`${meeting.folder}/transcript.local.md`, transcriptMarkdown(meeting)],
    ]
    if (meeting.minutes.trim() !== '') {
      files.push([minutesFile(meeting.folder, profile), `${meeting.minutes.trimEnd()}\n`])
    }
    for (const [rel, text] of files) {
      if (l.written.get(rel) === text) continue
      try {
        await deps.writeFile(rel, text)
        l.written.set(rel, text)
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
    if (m.topics.length > 0) m.minutes = renderMinutes(m)
    summaries.set(id, summaryOf(m))
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
      unblockedAt: 0,
      rescued: false,
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

  /** A meeting in memory, read from disk when it is an older one. */
  async function open(id: string): Promise<Live> {
    const known = live.get(id)
    if (known !== undefined) return known
    if (!/^[0-9a-f]{12}$/.test(id) || !summaries.has(id)) {
      throw new CapabilityError('NOT_FOUND', `no meeting ${id}`)
    }
    const stored = await readStored(id)
    if (stored === null) throw new CapabilityError('NOT_FOUND', `no meeting ${id}`)
    const l = liveOf(stored)
    live.set(id, l)
    return l
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
    const apiKey = await deps.apiKey().catch(() => null)
    if (disposed) return
    const missing = apiKey === null || apiKey === ''
    if (missing || apiKey === badKey) {
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
          wav,
          apiKey,
          model: profile.asrModel ?? DEFAULT_ASR_MODEL,
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
      if (meeting.blocked !== undefined) {
        delete meeting.blocked
        l.unblockedAt = now()
      }
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

  async function finish(id: string, startedFinishingAt: number): Promise<void> {
    const l = live.get(id)
    if (l === undefined) return
    const { meeting } = l.stored
    // What failed is tried once more, from the start of its backoff; a
    // rescued meeting tried what it could when it was rescued.
    for (const c of meeting.chunks) {
      if (c.state === 'failed' && !l.rescued) {
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
    // Time spent waiting for a key is not the scribe's: its final pass gets
    // the whole cap from when the key came.
    const deadline = Math.max(startedFinishingAt, l.unblockedAt) + FINISH_MS
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
   *  since. A task that cannot be written keeps what it said. */
  async function sendableTask(l: Live, card: Card, context?: string): Promise<string> {
    if (card.taskPath === undefined) return ensureTask(l, card, context)
    try {
      await deps.agent.updateTask({
        path: card.taskPath,
        description: cardSpec(card, specOf(l, card, context)),
      })
    } catch (err) {
      deps.log('warn', `meeting: could not update the task ${card.taskPath}: ${String(err)}`)
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
   *  and told to the scribe if it has read the line already (one it has not
   *  reaches it as it now reads). */
  function correct(l: Live, at: number, text: string): Segment {
    const { meeting } = l.stored
    const seg = meeting.segments[at]!
    const edited: Segment = { ...seg, text, edited: true }
    meeting.segments[at] = edited
    requote(meeting, seg.i, now())
    if (scribeListens(l) && seg.i <= meeting.scribeCursor) {
      notesOf(l).corrections[seg.i] = text
      scribe.feed(meeting.id)
    }
    return edited
  }

  return {
    async load() {
      await mkdir(deps.dir, { recursive: true })
      const ids = (await readdir(deps.dir).catch(() => [] as string[])).filter((id) =>
        /^[0-9a-f]{12}$/.test(id),
      )
      for (const id of ids) {
        const stored = await readStored(id)
        if (stored === null) continue
        summaries.set(id, summaryOf(stored.meeting))
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

    async start({ title, profileId }) {
      const profile = await deps.profiles.get(profileId)
      const at = now()
      const d = new Date(at)
      const name = title?.trim() || `Meeting ${pad(d.getHours())}.${pad(d.getMinutes())}`
      const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const base = `Meetings/${day} ${folderTitle(name)}`
      let folder = base
      const taken = new Set([...summaries.values()].map((s) => s.folder))
      for (let k = 2; taken.has(folder) || (await exists(join(deps.root, folder))); k++) {
        folder = `${base} (${k})`
      }
      const id = randomBytes(6).toString('hex')
      const meeting: MeetingState = {
        id,
        title: name,
        profileId,
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
      live.set(id, l)
      await persist(l)
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

    async stop(meetingId) {
      const l = await open(meetingId)
      const { meeting } = l.stored
      if (meeting.phase !== 'recording') return
      meeting.phase = 'finishing'
      meeting.endedAt = now()
      changed(meetingId)
      await persist(l)
      void finish(meetingId, meeting.endedAt).catch((err: unknown) =>
        deps.log('error', `meeting "${meeting.title}": could not finish: ${String(err)}`),
      )
    },

    get: async (meetingId) => (await open(meetingId)).stored.meeting,

    list: () => [...summaries.values()].sort((a, b) => b.startedAt - a.startedAt),

    async rename(meetingId, title) {
      const l = await open(meetingId)
      const name = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
      if (name === '') throw new CapabilityError('BAD_REQUEST', 'a meeting needs a title')
      l.stored.meeting.title = name
      changed(meetingId)
      return summaryOf(l.stored.meeting)
    },

    async remove(meetingId) {
      const l = await open(meetingId)
      const m = l.stored.meeting
      if (m.phase === 'recording' || m.phase === 'finishing') {
        throw new CapabilityError('CONFLICT', 'stop the meeting before deleting it')
      }
      for (const timer of [l.persistTimer, l.filesTimer, l.emitTimer]) {
        if (timer !== null) clearTimeout(timer)
      }
      deleted.add(meetingId)
      live.delete(meetingId)
      summaries.delete(meetingId)
      // Machine state first: once it is gone the meeting is gone, even if a
      // vault file cannot be removed. A save already under way finishes
      // before the folder goes, so it cannot bring the meeting back.
      await saving.get(meetingId)?.catch(() => {})
      await rm(dirOf(meetingId), { recursive: true, force: true, maxRetries: 3 })
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
      emitList()
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
      const l = await open(meetingId)
      const { meeting, profile } = l.stored
      const at = cardOf(l, cardId)
      const before = meeting.cards[at]!
      if (before.status === 'building' && before.buildSessionId !== undefined) {
        throw new CapabilityError('CONFLICT', 'this card was sent already')
      }
      const { context } = opts
      const target: SendTarget = opts.target ?? { kind: 'claude' }
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
        const res = await deps.agent.launch({
          name: `${card.kind === 'action' ? 'Action' : 'Build'} · ${card.title}`,
          prompt: buildBrief(card, { ...specOf(l, card, context), taskPath, profile }),
          ...(profile.buildModel === undefined ? {} : { model: profile.buildModel }),
          ...(profile.mcpConfig === undefined ? {} : { mcpConfig: profile.mcpConfig }),
        })
        if (!res.ok) throw new CapabilityError('UNAVAILABLE', res.message)
        sessionId = res.sessionId
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
      const text = `# ${meeting.title}\n\n${date}\n\n${meeting.minutes.trim()}\n`
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
      const card = taskCard(meeting, req, now())
      if (scribeListens(l)) {
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

    async dispose() {
      disposed = true
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
    void finish(id, now()).catch((err: unknown) =>
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
    void finish(meeting.id, now()).catch((err: unknown) =>
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
