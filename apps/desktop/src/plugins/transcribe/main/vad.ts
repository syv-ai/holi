/**
 * Voice activity detection in front of the speech model (docs/features/meetings.md).
 *
 * Speech models invent words in silence and noise, and the backend runs its
 * own Silero VAD only on clips over 32 s, so a 6–12 s chunk would reach the
 * model whole. Main runs Silero VAD (`silero.ts`) on each channel of a chunk
 * first, with the backend's tuned settings, and uploads only the speech:
 *
 * - **Regions.** Silero's speech timestamps, as the backend computes them:
 *   threshold 0.5, speech of at least 250 ms, a pause splits only at 300 ms,
 *   and 250 ms of padding on each side.
 * - **Splice.** The upload holds each region's audio, with 0.3 s of silence
 *   between regions further apart than that, and a time map back to the
 *   chunk, so a line's times are the chunk's own and Me/Them is judged on the
 *   original audio.
 * - **Who.** Both sides speak when each channel's VAD speech (the microphone's
 *   without the computer's echo) is a quarter of the chunk's; then each
 *   channel goes up on its own, as before. Otherwise one mono mix of the
 *   regions of either channel goes up.
 * - **Nothing.** A chunk, or a channel, with no speech region is not uploaded.
 * - **Fallback.** Without a VAD, or when it fails, the chunk goes up whole,
 *   as it did before the VAD.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  bothTalk,
  chunkSegments,
  roomSpeaker,
  speakerOf,
  splitSegments,
  talkOf,
  type AsrSegment,
  type ChunkSegment,
} from './stitcher'
import { channelWav, monoWav, rms, type Pcm } from './wav'

/** The detector: Silero's speech probability for each 512-sample window
 *  of 16 kHz audio, or null when it cannot run. */
export interface ChunkVad {
  speech(samples: Float32Array): Promise<Float32Array | null>
}

const RATE = 16_000
/** Silero v5 judges 512 new samples (32 ms) a step at 16 kHz. */
export const VAD_WINDOW = 512
/** The backend's settings (`vad_*` in its config), for the reasons given there. */
const THRESHOLD = 0.5
/** Speech ends below this; between it and the threshold, speech goes on. */
const NEG_THRESHOLD = THRESHOLD - 0.15
const MIN_SPEECH_SECONDS = 0.25
const MIN_SILENCE_SECONDS = 0.3
const PAD_SECONDS = 0.25
/** The silence an upload holds between two regions. */
const GAP_SECONDS = 0.3
/** As `stitcher.ts` judges speech and echo: 20 ms frames, and the computer
 *  this much louder than the microphone is its echo. */
const FRAME_SECONDS = 0.02
const ECHO_RATIO = 2
/** A channel with no 20 ms frame this loud (-60 dBFS) is not run through the
 *  model: the recorder counts nothing under -55 dBFS as speech either. */
const QUIET = 32768 * 10 ** (-60 / 20)

/** A stretch of a chunk, in samples. */
interface Region {
  start: number
  end: number
}

/**
 * Speech regions, unpadded, from one channel's probabilities: a port of
 * Silero's `get_speech_timestamps`, as the backend runs it. `length` is the
 * channel's sample count.
 *
 * @public exported for its test
 */
export function speechRuns(probs: ArrayLike<number>, length: number): Region[] {
  const minSpeech = RATE * MIN_SPEECH_SECONDS
  const minSilence = RATE * MIN_SILENCE_SECONDS
  const runs: Region[] = []
  let start: number | null = null
  let tempEnd = 0
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i]!
    const pos = VAD_WINDOW * i
    if (p >= THRESHOLD && tempEnd !== 0) tempEnd = 0
    if (p >= THRESHOLD && start === null) {
      start = pos
      continue
    }
    if (p < NEG_THRESHOLD && start !== null) {
      if (tempEnd === 0) tempEnd = pos
      if (pos - tempEnd < minSilence) continue
      if (tempEnd - start > minSpeech) runs.push({ start, end: tempEnd })
      start = null
      tempEnd = 0
    }
  }
  if (start !== null && length - start > minSpeech) runs.push({ start, end: length })
  return runs
}

/**
 * Each run padded on both sides; neighbours closer than two pads share the
 * gap between them, so regions never overlap.
 *
 * @public exported for its test
 */
export function padRuns(runs: readonly Region[], length: number): Region[] {
  const pad = Math.round(RATE * PAD_SECONDS)
  const out = runs.map((r) => ({ ...r }))
  for (let i = 0; i < out.length; i++) {
    const r = out[i]!
    const next = out[i + 1]
    if (i === 0) r.start = Math.max(0, r.start - pad)
    if (next === undefined) {
      r.end = Math.min(length, r.end + pad)
    } else {
      const gap = next.start - r.end
      if (gap < 2 * pad) {
        r.end += Math.floor(gap / 2)
        next.start = Math.max(0, next.start - Math.floor(gap / 2))
      } else {
        r.end = Math.min(length, r.end + pad)
        next.start = Math.max(0, next.start - pad)
      }
    }
  }
  return out
}

/**
 * Regions as one list: sorted, and joined where they overlap or the pause
 * between them is shorter than the silence an upload would put there.
 *
 * @public exported for its test
 */
export function joinRegions(...lists: ReadonlyArray<readonly Region[]>): Region[] {
  const all = lists.flat().sort((a, b) => a.start - b.start)
  const out: Region[] = []
  for (const r of all) {
    const last = out.at(-1)
    if (last !== undefined && r.start - last.end < RATE * GAP_SECONDS) {
      last.end = Math.max(last.end, r.end)
    } else {
      out.push({ ...r })
    }
  }
  return out
}

/** Where a stretch of the upload came from: `at` seconds into the upload is
 *  `from` seconds into the chunk, for `length` seconds. */
interface Piece {
  at: number
  from: number
  length: number
}

/**
 * The chunk's regions, back to back with `GAP_SECONDS` of silence between
 * them, both channels alike, and the map back.
 *
 * @public exported for its test
 */
export function splice(pcm: Pcm, regions: readonly Region[]): { pcm: Pcm; pieces: Piece[] } {
  const gap = Math.round(pcm.rate * GAP_SECONDS)
  const joined = joinRegions(regions).map((r) => ({
    start: Math.max(0, r.start),
    end: Math.min(pcm.left.length, r.end),
  }))
  const kept = joined.filter((r) => r.end > r.start)
  const total = kept.reduce((n, r) => n + r.end - r.start, 0) + gap * Math.max(0, kept.length - 1)
  const left = new Int16Array(total)
  const right = new Int16Array(total)
  const pieces: Piece[] = []
  let at = 0
  for (const [k, r] of kept.entries()) {
    if (k > 0) at += gap
    left.set(pcm.left.subarray(r.start, r.end), at)
    right.set(pcm.right.subarray(r.start, r.end), at)
    pieces.push({
      at: at / pcm.rate,
      from: r.start / pcm.rate,
      length: (r.end - r.start) / pcm.rate,
    })
    at += r.end - r.start
  }
  return { pcm: { rate: pcm.rate, left, right, channels: pcm.channels }, pieces }
}

/**
 * A time in the upload as a time in the chunk. A time in the silence between
 * two pieces is the next piece's start for a line's start, and the last
 * piece's end for its end.
 *
 * @public exported for its test
 */
export function chunkTime(pieces: readonly Piece[], t: number, edge: 'start' | 'end'): number {
  let before: Piece | undefined
  for (const p of pieces) {
    if (t < p.at)
      return edge === 'start' || before === undefined ? p.from : before.from + before.length
    if (t <= p.at + p.length) return p.from + (t - p.at)
    before = p
  }
  return before === undefined ? t : before.from + before.length
}

/** The service's lines for a spliced upload, timed in the chunk. */
function remap(segments: readonly AsrSegment[], pieces: readonly Piece[]): AsrSegment[] {
  return segments.map((s) => {
    const start = chunkTime(pieces, Number(s.start) || 0, 'start')
    const end = chunkTime(pieces, Number(s.end) || 0, 'end')
    return { ...s, start, end: Math.max(start, end) }
  })
}

/** One channel's speech: unpadded runs (what is said) and padded regions
 *  (what goes up). */
interface ChannelSpeech {
  runs: Region[]
  regions: Region[]
}

async function channelSpeech(vad: ChunkVad, samples: Int16Array): Promise<ChannelSpeech | null> {
  const seconds = samples.length / RATE
  let heard = false
  for (let t = 0; t < seconds && !heard; t += FRAME_SECONDS) {
    heard = rms(samples, RATE, t, t + FRAME_SECONDS) >= QUIET
  }
  if (!heard) return { runs: [], regions: [] }
  const floats = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i]! / 32768
  const probs = await vad.speech(floats)
  if (probs === null) return null
  const runs = speechRuns(probs, samples.length)
  return { runs, regions: padRuns(runs, samples.length) }
}

/** Each channel's speech, or null when the VAD cannot judge this chunk. */
async function speechOf(
  pcm: Pcm,
  vad: ChunkVad,
): Promise<{ left: ChannelSpeech; right: ChannelSpeech } | null> {
  if (pcm.rate !== RATE) return null
  try {
    const left = await channelSpeech(vad, pcm.left)
    if (left === null) return null
    if (pcm.channels === 1) return { left, right: left }
    const right = await channelSpeech(vad, pcm.right)
    return right === null ? null : { left, right }
  } catch {
    return null
  }
}

/**
 * Which 20 ms frames carry speech on each side, as `stitcher.ts` reads them,
 * from the VAD: a frame within a channel's speech, and for the microphone
 * not one the computer is twice as loud in (its echo).
 *
 * @public exported for its test
 */
export function vadTalk(
  pcm: Pcm,
  left: readonly Region[],
  right: readonly Region[],
): ReturnType<typeof talkOf> {
  const frames = Math.floor(pcm.left.length / (pcm.rate * FRAME_SECONDS))
  const me = new Uint8Array(frames)
  const them = new Uint8Array(frames)
  const within = (regions: readonly Region[], sample: number) =>
    regions.some((r) => sample >= r.start && sample < r.end)
  for (let f = 0; f < frames; f++) {
    const from = f * FRAME_SECONDS
    const mid = Math.floor((from + FRAME_SECONDS / 2) * pcm.rate)
    them[f] = within(right, mid) ? 1 : 0
    if (within(left, mid)) {
      const to = from + FRAME_SECONDS
      const echo =
        rms(pcm.right, pcm.rate, from, to) >= ECHO_RATIO * rms(pcm.left, pcm.rate, from, to)
      me[f] = echo ? 0 : 1
    }
  }
  return { frameSeconds: FRAME_SECONDS, me, them }
}

/**
 * Chunk `n`'s lines: what its speech says, from as many uploads as it takes
 * (none, one mono mix, or one per channel when both sides speak), labelled
 * and timed in the meeting.
 */
export async function transcribeChunk(args: {
  pcm: Pcm
  chunk: { n: number; start: number; duration: number }
  /** One microphone in a room: the service's speaker labels, not Me/Them. */
  roomDiarize: boolean
  /** Absent, the chunk goes up whole. */
  vad: ChunkVad | undefined
  ask(wav: Uint8Array): Promise<AsrSegment[]>
}): Promise<ChunkSegment[]> {
  const { pcm, chunk, roomDiarize, ask } = args
  const label = (seg: AsrSegment, from: number, to: number) =>
    roomDiarize ? roomSpeaker(seg.speaker) : speakerOf(pcm, from, to)
  const sides = !roomDiarize && pcm.channels === 2
  const speech = args.vad === undefined ? null : await speechOf(pcm, args.vad)

  if (speech === null) {
    const talk = sides ? talkOf(pcm) : null
    if (talk !== null && bothTalk(talk)) {
      // Both at once: a split chunk takes no longer than a mixed one.
      const [me, them] = await Promise.all([
        ask(channelWav(pcm, 'left')),
        ask(channelWav(pcm, 'right')),
      ])
      return splitSegments({ me, them }, pcm, talk, chunk)
    }
    return chunkSegments(await ask(monoWav(pcm)), chunk, label)
  }

  const talk = sides ? vadTalk(pcm, speech.left.runs, speech.right.runs) : null
  if (talk !== null && bothTalk(talk)) {
    const side = async (regions: readonly Region[], channel: 'left' | 'right') => {
      const cut = splice(pcm, regions)
      return remap(await ask(channelWav(cut.pcm, channel)), cut.pieces)
    }
    const [me, them] = await Promise.all([
      side(speech.left.regions, 'left'),
      side(speech.right.regions, 'right'),
    ])
    return splitSegments({ me, them }, pcm, talk, chunk)
  }
  const regions = joinRegions(speech.left.regions, speech.right.regions)
  if (regions.length === 0) return []
  const cut = splice(pcm, regions)
  return chunkSegments(remap(await ask(monoWav(cut.pcm)), cut.pieces), chunk, label)
}
