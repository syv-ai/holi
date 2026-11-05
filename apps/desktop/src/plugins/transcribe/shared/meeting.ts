// The shapes a meeting has, shared by the transcribe plugin's main and renderer sides.

import type { AgentProviderId } from '@holi/shared'

/** One transcribed stretch of speech. `i` is stable for the whole meeting and is what cards cite. */
export interface Segment {
  i: number
  /** 'Me' (mic channel), 'Them' (computer audio), or 'Speaker N' (mono room audio). */
  speaker: string
  /** Seconds from meeting start. */
  start: number
  end: number
  text: string
  /** Chunk number the segment came from. */
  chunk: number
  /** A person corrected its words in Holi (`meeting.segment.edit`). */
  edited?: boolean
}

export interface GlossaryEntry {
  term: string
  /** Ways the speech model tends to mishear it, e.g. ["klort", "klod"] for "Claude". */
  heardAs: string[]
}

/** What a speaker is called on screen and in what a person reads: the
 *  microphone and the computer's sound by their source, a numbered voice in
 *  the room as it is. Stored lines keep 'Me' and 'Them', so older meetings
 *  and what the scribe is sent stay as they were. */
export function speakerName(speaker: string): string {
  return speaker === 'Me' ? 'Mic audio' : speaker === 'Them' ? 'System audio' : speaker
}

export interface MeetingProfile {
  id: string
  name: string
  /** What we build on: product, repo, stack — free text shown to the scribe and the build agent. */
  platform: string
  /** Absolute path of the repo build agents should work in (optional). */
  repoPath?: string
  /** What counts as a feature worth a card in this kind of meeting. */
  focus: string
  /** Topics and kinds of talk to ignore. */
  ignore: string
  glossary: GlossaryEntry[]
  /** Extra instructions appended to the scribe's brief. */
  instructions: string
  /** Speech language: 'da' | 'en' | 'auto'. */
  language: 'da' | 'en' | 'auto'
  /** Claude model alias for the scribe (default: the agent default). */
  scribeModel?: string
  /** Claude model alias for build runs. */
  buildModel?: string
  /** Absolute path to an MCP JSON config passed to scribe and build sessions. */
  mcpConfig?: string
  /** Write minutes.md (synced) instead of minutes.local.md. */
  shareMinutes: boolean
  /** Keep chunk audio after transcription. */
  keepAudio: boolean
  /** Speech model: 'syv-transcribe' (the default) or 'syvai/hviske-v5.3' (faster captions). */
  asrModel?: string
  /** One microphone in a room: the service tells speakers apart ('Speaker N') instead of Me/Them. */
  roomDiarize?: boolean
}

export type CardKind = 'feature' | 'action'
/** `suggested` is only on cards the scribe made before groups. */
export type CardStatus = 'suggested' | 'accepted' | 'building' | 'dismissed'

export interface Quote {
  i: number
  speaker: string
  start: number
  /** Copied from the stored segment by code, never from the model. */
  text: string
}

/** What makes a vault folder a meeting the tree opens as one document:
 *  `Meetings/2026-11-02 Planning.meeting/`. */
export const MEETING_SUFFIX = '.meeting'

/** Line `i` of a transcript. Lines are numbered by their place, and the
 *  transcript only grows (`stitch`), so line `i` is `segments[i]`. */
export const lineAt = (segments: readonly Segment[], i: number): Segment | undefined => segments[i]

/** A meeting's transcript in its folder: kept on this machine, and the file
 *  the tree opens the folder as. */
export const TRANSCRIPT_FILE = 'transcript.local.md'

/** A meeting's minutes in its folder: on this machine, or shared with the
 *  vault (`MeetingProfile.shareMinutes`). */
export const MINUTES_FILES = { local: 'minutes.local.md', shared: 'minutes.md' } as const

/** How long a person's ask for a task may be. */
export const MAX_PROMPT = 2000

/** How long a person's note on how to do a task may be. */
export const MAX_CONTEXT = 2000

/** The speech service meetings are transcribed with (`speech-service.ts`):
 *  `url` null is syv.ai's; else any service that answers OpenAI's
 *  `/audio/transcriptions`, asked for `model`. */
export interface SpeechService {
  url: string | null
  model: string | null
}

/** Who a task is sent to: the vault's chosen agent (Settings, General,
 *  Agents), or one of the vault's Holis (docs/features/holis.md). */
export type SendTarget = { kind: 'agent' } | { kind: 'holi'; id: string }

/** The stretch of a meeting a task's lines span, in seconds from its start. */
export interface CardRange {
  start: number
  end: number
  /** How many transcript lines it was made from: more than the card's
   *  segments when there were more than a task holds. */
  lines: number
}

/**
 * A task: what a person made from the meeting (a group, a suggestion, or a
 * stretch they picked) and sends to an agent. Cards the scribe made itself
 * belong to meetings saved before groups.
 */
export interface Card {
  id: string
  kind: CardKind
  title: string
  /** What the person asks; on an older scribe card, why it matters. */
  why: string
  /** The transcript lines it carries, ascending. */
  segments: number[]
  acceptance: string[]
  openQuestions: string[]
  owner?: string
  /** A task a person made. Absent only on an older meeting's scribe card. */
  origin?: 'person'
  /** The span its lines cover. */
  range?: CardRange
  /** The group, and the suggestion in it, it was made from. */
  from?: { topicId: string; suggestionId?: string }
  quotes: Quote[]
  /** `building` once sent to an agent: the name is kept for meetings saved
   *  before, and the UI says Sent or Running. */
  status: CardStatus
  taskPath?: string
  /** The session the card was sent to. */
  buildSessionId?: string
  /** Who it was sent to; absent on a card sent before targets, an agent run. */
  target?: SendTarget
  createdAt: number
  updatedAt: number
}

/** Something to build or do that came up in a group, as the scribe saw it:
 *  nothing happens until a person sends it. */
export interface Suggestion {
  /** Given by code, kept while the scribe keeps the suggestion. */
  id: string
  kind: CardKind
  title: string
  why: string
  /** The lines that say it, in this group or an earlier one. Quotes are
   *  the transcript's, looked up by code. */
  segments: number[]
}

/** What a person can edit of a group; once edited, the scribe may not
 *  change it. */
export type TopicField = 'title' | 'summary' | 'keywords' | 'decisions' | 'questions'

/**
 * A group: a contiguous stretch of the meeting on one subject, and the
 * backbone of the minutes. The scribe says where each one starts and writes
 * it (`holi meeting group`); code derives its lines and times. The last one
 * is open while the meeting records: new lines join it.
 */
export interface Topic {
  /** From its first line, so it stays the same while the topic does. */
  id: string
  /** At most 8 words, in the meeting's language; empty until written. */
  title: string
  /** 2–4 bullets once the group is written. */
  summary: string[]
  /** 2–5. */
  keywords: string[]
  /** The transcript lines (segment `i`) in it, ascending and contiguous. */
  lines: number[]
  /** Seconds from the meeting's start: its first line's start, its last
   *  line's end (never past the next topic's start). */
  start: number
  end: number
  /** The topic being talked about now: new lines join it while the meeting
   *  records. */
  open: boolean
  decisions: string[]
  questions: string[]
  suggestions: Suggestion[]
  /** Who took part in it, by the names said in the meeting; absent when
   *  none was. The minutes list them as the participants. */
  people?: string[]
  /** When a person last edited it. */
  editedAt?: number
  /** The fields a person edited: theirs, which the scribe may not change. */
  edited?: TopicField[]
  /** Not written yet as it stands (closed unwritten, split or merged): the
   *  scribe writes it in its next batch. */
  stale?: boolean
  /** A person joined this group to another about the same subject: the id of
   *  the group heading the set, its earliest (`joins.ts`). The set reads as
   *  one topic; each group stays the stretch the scribe wrote. */
  joinedTo?: string
}

export type ChunkState = 'queued' | 'uploading' | 'done' | 'failed'

export interface ChunkInfo {
  n: number
  start: number
  duration: number
  state: ChunkState
  tries: number
  /** ms from chunk received by main to segments stored. */
  latencyMs?: number
  /** What went wrong, in words for the person. */
  error?: string
  /** Why it failed or waits, where that decides what becomes of it: the
   *  speech key (sent again once it changes), or the renderer gave up on it
   *  (never sent again). */
  reason?: MeetingBlock | 'lost'
}

export type MeetingPhase = 'recording' | 'finishing' | 'done' | 'failed'
/** Why uploads wait: no speech key is set, or the service refused the one
 *  that is. Chunks stay queued, untried, until the key changes. */
export type MeetingBlock = 'no-key' | 'bad-key'
export type ScribeState = 'off' | 'starting' | 'working' | 'idle' | 'needs-you' | 'gone'

export interface MeetingState {
  id: string
  title: string
  profileId: string
  startedAt: number
  endedAt?: number
  phase: MeetingPhase
  segments: Segment[]
  /** The minutes as markdown, rendered by code from the groups and tasks;
   *  a meeting saved before groups keeps the scribe's. */
  minutes: string
  /** When the scribe last wrote a group. */
  minutesAt?: number
  /** The tasks made from the meeting. */
  cards: Card[]
  /** The groups, in order: contiguous, the last open while recording. */
  topics: Topic[]
  scribeSessionId?: string
  scribeState: ScribeState
  /** Index of the last segment the scribe has been sent. */
  scribeCursor: number
  chunks: ChunkInfo[]
  /** Set while uploads wait on the speech key. */
  blocked?: MeetingBlock
  /** The scribe was never reached: its session never said where it takes
   *  messages (a vault hook from before inbox channels). Sends go on, slowly. */
  scribeUnreachable?: boolean
  /** The vault's agent cannot run the scribe (Claude Code and Pi can): the
   *  meeting records and captions without topics. */
  scribeUnsupported?: AgentProviderId
  /** Vault-relative folder, e.g. "Meetings/2026-11-02 Planning.meeting". */
  folder: string
  /** The vault path the minutes are written to, in that folder. */
  minutesPath?: string
}

export interface MeetingSummary {
  id: string
  title: string
  startedAt: number
  phase: MeetingPhase
  cards: number
  folder: string
  /** Its folder is not at `folder` any more, and no folder in the vault
   *  carries its id: it is listed, but no folder opens it. */
  away?: true
}

/** A closed stretch of captured audio: 16 kHz, 16-bit PCM WAV, stereo with the mic left and computer audio right. */
export interface CapturedChunk {
  n: number
  /** Seconds from capture start. */
  start: number
  duration: number
  wav: ArrayBuffer
}

export interface CaptureOptions {
  microphone: boolean
  system: boolean
  onChunk: (chunk: CapturedChunk) => void
  /** 0..1 loudness, about 20 times a second. */
  onLevel?: (level: number) => void
}

export interface Capture {
  /** Stops capturing and emits the last partial chunk through onChunk. */
  stop: () => Promise<void>
  /** What it records: a source asked for that could not be had is false. */
  sources: { microphone: boolean; system: boolean }
  /** Why a source asked for is not recorded, in words the person can act on. */
  problems: readonly string[]
}

// The capabilities that carry these between main and the renderer, with
// their arguments and doors, are `main/capabilities.ts`.
