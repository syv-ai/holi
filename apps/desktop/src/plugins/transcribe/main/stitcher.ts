/**
 * From each chunk's transcription to one transcript: who spoke, what is not
 * speech at all, and the order.
 *
 * - **Who.** The microphone is "Me", the computer's sound "Them". When both
 *   carry speech in a chunk (`talkOf`, `bothTalk`), each channel is
 *   transcribed on its own and its lines are labelled by the channel they
 *   came from (`splitSegments`), so a line never straddles a change of
 *   speaker; a microphone line that is only the computer's sound leaking
 *   into it (echo) is dropped. Otherwise the service hears a mono mix and
 *   the louder channel over each line's window wins (`speakerOf`). A
 *   profile for one microphone in a room asks the service for its labels
 *   instead ("Speaker N").
 * - **Junk.** Speech models trained on broadcast subtitles fill silence with
 *   the credits they were trained on ("Undertekster af…", "DR P1"), and loop
 *   on a phrase. `cleanSegments` drops the first (`ASR_JUNK`) and collapses
 *   the second in each chunk; as a chunk is stitched, `dropHallucinations`
 *   (`junk.ts`) drops timestamp loops, the microphone's echo of the speakers,
 *   and short bursts of broadcast cliché, against the transcript before it.
 * - **Order.** Chunks finish out of order (two upload at once, and one may
 *   retry), so a chunk's segments wait until every earlier chunk is in, and
 *   only then get their index `i`: an index is given once, in order, and never
 *   changes, which is what a card citing it relies on.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { Segment } from '../shared/meeting'
import { dropHallucinations, isAsrJunk, trimmed, type Dropped } from './junk'
import { rms, type Pcm } from './wav'

/** A segment of one chunk, timed from the meeting's start, before its index. */
export type ChunkSegment = Omit<Segment, 'i'> & {
  /** The service's `compression_ratio` for the text as it is, when it gave one. */
  compression?: number
}

/** What the service answers for one segment (`verbose_json`). */
export interface AsrSegment {
  start: number
  end: number
  text: string
  speaker?: unknown
  /** The service's `compression_ratio`: its text's bytes over their gzip. */
  compression?: number
}

const word = (w: string): string => w.toLowerCase().replace(/[.,!?;:"'“”…]+/g, '')

/**
 * A phrase the model repeats three or more times in a row, said once: "ja ja
 * ja ja" is "ja", and a sentence looping ten times is that sentence. Two in a
 * row is how people talk, and stays.
 *
 * @public exported for its test
 */
export function collapseRepeats(text: string): string {
  const words = text.trim().split(/\s+/)
  if (words.length < 3) return text.trim()
  const out: string[] = []
  let i = 0
  while (i < words.length) {
    let taken = false
    for (let n = 1; n <= 12 && i + n * 3 <= words.length; n++) {
      const unit = words.slice(i, i + n).map(word)
      let reps = 1
      while (
        i + (reps + 1) * n <= words.length &&
        words
          .slice(i + reps * n, i + (reps + 1) * n)
          .map(word)
          .every((w, k) => w === unit[k])
      ) {
        reps++
      }
      if (reps >= 3) {
        out.push(...words.slice(i, i + n))
        i += reps * n
        taken = true
        break
      }
    }
    if (!taken) out.push(words[i++]!)
  }
  return out.join(' ')
}

/**
 * One chunk's segments without the junk: hallucinated credits dropped, loops
 * within a segment collapsed, and a segment that only repeats the one before
 * it (the same speaker, the same words, a third time or at six words or more)
 * dropped.
 *
 * @public exported for its test
 */
export function cleanSegments(segments: readonly ChunkSegment[]): ChunkSegment[] {
  const out: ChunkSegment[] = []
  let run = 0
  for (const seg of segments) {
    if (isAsrJunk(seg.text)) continue
    const text = collapseRepeats(seg.text)
    if (isAsrJunk(text)) continue
    const prev = out.at(-1)
    const same =
      prev !== undefined &&
      prev.speaker === seg.speaker &&
      trimmed(prev.text).toLowerCase() === trimmed(text).toLowerCase()
    run = same ? run + 1 : 1
    if (same && (run >= 3 || text.split(/\s+/).length >= 6)) continue
    const kept: ChunkSegment = { ...seg, text }
    // The service measured the loop, not what is left of it.
    if (text !== seg.text) delete kept.compression
    out.push(kept)
  }
  return out
}

/** "Me" or "Them", by which channel is louder over the window (seconds into
 *  the chunk). A tie, silence included, is "Me": without the computer's
 *  sound everything is. */
export function speakerOf(pcm: Pcm, from: number, to: number): 'Me' | 'Them' {
  if (pcm.channels === 1) return 'Me'
  const me = rms(pcm.left, pcm.rate, from, to)
  const them = rms(pcm.right, pcm.rate, from, to)
  return them > me ? 'Them' : 'Me'
}

/** Speech, as the recorder judges it (`renderer/audio/chunker.ts`): a 20 ms
 *  frame this far above the channel's quietest, within these bounds. */
const FRAME_SECONDS = 0.02
const MARGIN_DB = 10
const MIN_THRESHOLD_DB = -55
const MAX_THRESHOLD_DB = -30
/** The computer this much louder than the microphone: the microphone hears
 *  the speakers, not a person. */
const ECHO_RATIO = 2
/** Each side's share of a chunk's speech for both to count as speaking. */
const BOTH_SHARE = 0.25
/** Less speech than this (100 ms) on a side is none. */
const MIN_TALK_FRAMES = 5

/** Which 20 ms frames of a stereo chunk carry speech, side by side. A
 *  microphone frame the computer is twice as loud in is its echo, not speech. */
interface Talk {
  frameSeconds: number
  me: Uint8Array
  them: Uint8Array
}

const dbfs = (value: number): number => 20 * Math.log10(Math.max(value, 1e-3) / 32768)

export function talkOf(pcm: Pcm): Talk {
  const frames = Math.floor(pcm.left.length / (pcm.rate * FRAME_SECONDS))
  const level = (ch: Int16Array) =>
    Array.from({ length: frames }, (_, f) =>
      rms(ch, pcm.rate, f * FRAME_SECONDS, (f + 1) * FRAME_SECONDS),
    )
  const left = level(pcm.left)
  const right = level(pcm.right)
  const threshold = (levels: number[]) => {
    const floor = Math.min(...levels.map(dbfs))
    return Math.min(MAX_THRESHOLD_DB, Math.max(MIN_THRESHOLD_DB, floor + MARGIN_DB))
  }
  const [meAt, themAt] = [threshold(left), threshold(right)]
  const me = new Uint8Array(frames)
  const them = new Uint8Array(frames)
  for (let f = 0; f < frames; f++) {
    them[f] = dbfs(right[f]!) >= themAt ? 1 : 0
    me[f] = dbfs(left[f]!) >= meAt && right[f]! < ECHO_RATIO * left[f]! ? 1 : 0
  }
  return { frameSeconds: FRAME_SECONDS, me, them }
}

const count = (frames: Uint8Array, from = 0, to = frames.length): number => {
  let n = 0
  for (let f = Math.max(0, from); f < Math.min(frames.length, to); f++) n += frames[f]!
  return n
}

/** Both sides speak: each has at least a quarter of the chunk's speech. */
export function bothTalk(talk: Talk): boolean {
  let any = 0
  for (let f = 0; f < talk.me.length; f++) any += talk.me[f]! | talk.them[f]!
  const enough = Math.max(MIN_TALK_FRAMES, BOTH_SHARE * any)
  return count(talk.me) >= enough && count(talk.them) >= enough
}

/**
 * Chunk `n`'s lines from its two channels, each transcribed on its own: the
 * microphone's are Me, the computer's Them, in the order they start. A line
 * whose channel has no speech over its window is the model filling silence,
 * and a microphone line the computer is twice as loud over is its echo:
 * both are dropped.
 */
export function splitSegments(
  sides: { me: readonly AsrSegment[]; them: readonly AsrSegment[] },
  pcm: Pcm,
  talk: Talk,
  chunk: { n: number; start: number; duration: number },
): ChunkSegment[] {
  const within = (t: number) => Math.min(Math.max(0, t), chunk.duration)
  const spoken = (seg: AsrSegment, side: 'me' | 'them'): boolean => {
    const from = within(Number(seg.start) || 0)
    const to = within(Number(seg.end) || from)
    if (to <= from) return false
    const a = Math.floor(from / talk.frameSeconds)
    const b = Math.ceil(to / talk.frameSeconds)
    if (count(talk[side], a, b) < Math.min(MIN_TALK_FRAMES, b - a)) return false
    return (
      side === 'them' ||
      rms(pcm.right, pcm.rate, from, to) < ECHO_RATIO * rms(pcm.left, pcm.rate, from, to)
    )
  }
  const raw = [
    ...sides.me.filter((s) => spoken(s, 'me')).map((s) => ({ ...s, speaker: 'Me' })),
    ...sides.them.filter((s) => spoken(s, 'them')).map((s) => ({ ...s, speaker: 'Them' })),
  ].sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0))
  return chunkSegments(raw, chunk, (seg) => (seg.speaker === 'Them' ? 'Them' : 'Me'))
}

/** The service's speaker label as "Speaker N": `0`, `"SPEAKER_00"`, `"speaker_1"`
 *  and `"A"` are speakers 1, 1, 2 and 1. */
export function roomSpeaker(label: unknown): string {
  if (typeof label === 'number' && Number.isInteger(label)) return `Speaker ${label + 1}`
  if (typeof label === 'string') {
    const digits = /(\d+)\s*$/.exec(label)?.[1]
    if (digits !== undefined) return `Speaker ${Number(digits) + 1}`
    const letter = /^[A-Za-z]$/.exec(label.trim())?.[0]
    if (letter !== undefined) return `Speaker ${letter.toUpperCase().charCodeAt(0) - 64}`
  }
  return 'Speaker 1'
}

/**
 * The service's segments for chunk `n`, timed from the meeting's start and
 * labelled, then cleaned. Times are clamped to the chunk, so a segment never
 * runs into the next one's.
 */
export function chunkSegments(
  raw: readonly AsrSegment[],
  chunk: { n: number; start: number; duration: number },
  label: (seg: AsrSegment, from: number, to: number) => string,
): ChunkSegment[] {
  const within = (t: number) => Math.min(Math.max(0, t), chunk.duration)
  return cleanSegments(
    raw
      .filter((s) => typeof s.text === 'string' && s.text.trim() !== '')
      .map((s) => {
        const from = within(Number(s.start) || 0)
        const to = Math.max(from, within(Number(s.end) || from))
        return {
          speaker: label(s, from, to),
          start: chunk.start + from,
          end: chunk.start + to,
          text: s.text.trim(),
          chunk: chunk.n,
          ...(typeof s.compression === 'number' && Number.isFinite(s.compression)
            ? { compression: s.compression }
            : {}),
        }
      }),
  )
}

/** What the stitcher keeps between chunks. Plain data: it is persisted. */
export interface StitchState {
  /** The transcript so far, its indices given. */
  segments: Segment[]
  /** The next chunk number the transcript waits for. Chunks count from 0. */
  next: number
  /** Transcribed chunks waiting for an earlier one, by chunk number. */
  pending: Record<number, ChunkSegment[]>
}

/**
 * Append every chunk that is now next in line. A chunk in `skip` (failed for
 * good) is passed over as if it said nothing. `final` stitches whatever is
 * pending, in chunk order, past any gap: the meeting is over and nothing
 * earlier is coming. A chunk's lines that nobody said (`dropHallucinations`)
 * get no index and come back in `dropped`, with why.
 */
export function stitch(
  state: StitchState,
  opts: { skip?: ReadonlySet<number>; final?: boolean } = {},
): { state: StitchState; added: Segment[]; dropped: Dropped[] } {
  const segments = [...state.segments]
  const pending = { ...state.pending }
  const added: Segment[] = []
  const dropped: Dropped[] = []
  let next = state.next
  const take = (n: number) => {
    const lines = [...(pending[n] ?? [])].sort((a, b) => a.start - b.start)
    const judged = dropHallucinations(lines, segments)
    dropped.push(...judged.dropped)
    for (const { speaker, start, end, text, chunk } of judged.kept) {
      const s: Segment = { i: segments.length, speaker, start, end, text, chunk }
      segments.push(s)
      added.push(s)
    }
    delete pending[n]
  }
  for (;;) {
    if (pending[next] !== undefined || opts.skip?.has(next) === true) {
      take(next)
      next++
    } else if (opts.final === true) {
      const later = Object.keys(pending)
        .map(Number)
        .filter((n) => n > next)
        .sort((a, b) => a - b)[0]
      if (later === undefined) break
      next = later
    } else {
      break
    }
  }
  return { state: { segments, next, pending }, added, dropped }
}
