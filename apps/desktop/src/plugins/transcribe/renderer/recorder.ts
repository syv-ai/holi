/**
 * The recording controller: one meeting being recorded, held at module level
 * and in atoms rather than in the surface, so moving to another tab keeps it
 * recording.
 *
 * Record first asks main whether meetings can be transcribed as things are
 * (a speech service with what it needs), and starts nothing when they
 * cannot, so a person finds out before the meeting rather than after. Then
 * it starts the meeting in main (`meeting.start`), then the capture, whose
 * chunks go to `meeting.chunk` as they close. Stop stops the capture (which
 * hands over its last partial chunk), waits for every upload, then stops the
 * meeting. A Stop while Record is still starting cancels it: whatever the
 * start got after that (the meeting, the capture) is let go as it arrives.
 *
 * A chunk that fails to reach main is retried, then given up on and told to
 * main (`meeting.chunk.lost`), so the transcript goes on past it; it never
 * stops the recording. A source asked for that cannot be had (the
 * computer's sound, say) leaves the other recording, and says so.
 */
import { atom } from 'jotai'
import { activeRemoteAtom } from '@/plugin-api'
import type { Capture, CapturedChunk } from '../shared/meeting'
import { startCapture } from './audio/capture'
import { base64 } from './format'
import { meetingCap } from './meeting-cap'
import { markStoppedAtom, message, shownMeetingIdAtom, speechKeyAtom } from './state'

export interface RecorderState {
  phase: 'idle' | 'starting' | 'recording' | 'stopping'
  meetingId: string | null
  remote: string | null
  /** Epoch ms the capture started. */
  startedAt: number | null
  /** The last thing that went wrong, in words to show; kept after a stop. */
  error: string | null
  /** What records, once the capture runs. */
  sources: { microphone: boolean; system: boolean } | null
  /** A source asked for that is not recorded, and how to fix it. */
  warning: string | null
  /** Chunks that never reached main. */
  failedUploads: number
}

const IDLE: RecorderState = {
  phase: 'idle',
  meetingId: null,
  remote: null,
  startedAt: null,
  error: null,
  sources: null,
  warning: null,
  failedUploads: 0,
}

export const recorderAtom = atom<RecorderState>(IDLE)

/** The capture's loudness, 0..1, about 20 times a second. Its own atom, so
 *  only the meter re-renders that often. */
export const levelAtom = atom(0)

/** Whether a meeting is being recorded (or started, or stopped). */
export const recordingAtom = atom((get) => get(recorderAtom).phase !== 'idle')

export const clearRecorderErrorAtom = atom(null, (_get, set) =>
  set(recorderAtom, (s) => ({ ...s, error: null, warning: null })),
)

let capture: Capture | null = null
const uploads = new Set<Promise<void>>()
/** Bumped by a Stop during a start: the start it began with is cancelled. */
let generation = 0

/** Tries per chunk, and the wait before each retry. */
const TRIES = 3
const RETRY_MS = 300

/** What Record says when meetings cannot be transcribed yet. */
const NOT_SET_UP =
  'Set up transcription before recording: choose a speech service, and save its key if it needs one.'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Why the capture did not start, as the person can act on it. */
function captureError(e: unknown): string {
  if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
    return 'Holi may not record here. Allow the microphone (and screen recording, for computer audio) in System Settings › Privacy & Security, then press Record again.'
  }
  return `Recording didn’t start: ${message(e)}`
}

export interface StartArgs {
  /** The profile; this machine's default without one. */
  profileId: string | null
  title: string
  microphone: boolean
  system: boolean
  /** The meeting folder to record in, made by the New menu; else a new one
   *  under `Meetings`. */
  path?: string
}

export const startRecordingAtom = atom(null, async (get, set, args: StartArgs): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (get(recorderAtom).phase !== 'idle' || remote === null) return
  const mine = ++generation
  const cancelled = () => generation !== mine
  set(recorderAtom, { ...IDLE, phase: 'starting', remote })

  // Asked fresh: a service set up in another window counts.
  try {
    const status = await meetingCap['key.status'](remote)
    set(speechKeyAtom, status)
    if (status.ready === false) {
      set(recorderAtom, { ...IDLE, error: NOT_SET_UP })
      return
    }
  } catch {
    // Unknown is not a reason to stop: main says so if it cannot transcribe.
  }
  if (cancelled()) return

  let meetingId: string
  try {
    const title = args.title.trim()
    ;({ meetingId } = await meetingCap.start(remote, {
      ...(args.profileId === null ? {} : { profileId: args.profileId }),
      ...(title === '' ? {} : { title }),
      ...(args.path === undefined ? {} : { path: args.path }),
    }))
  } catch (e) {
    if (!cancelled())
      set(recorderAtom, { ...IDLE, error: `The meeting didn’t start: ${message(e)}` })
    return
  }
  if (cancelled()) {
    // Stopped while it started: the meeting heard nothing and closes.
    void meetingCap.stop(remote, { meetingId }).catch(() => {})
    return
  }
  set(recorderAtom, (s) => ({ ...s, meetingId }))
  set(shownMeetingIdAtom, meetingId)

  const lost = (chunk: CapturedChunk, error: unknown) => {
    set(recorderAtom, (s) =>
      s.meetingId === meetingId
        ? {
            ...s,
            failedUploads: s.failedUploads + 1,
            error: `Chunk ${chunk.n} didn’t reach Holi: ${message(error)}. Still recording.`,
          }
        : s,
    )
    // Main stitches past it rather than wait for it; if main cannot be
    // reached either, the stop's final pass does.
    void meetingCap['chunk.lost'](remote, {
      meetingId,
      n: chunk.n,
      start: chunk.start,
      duration: chunk.duration,
    }).catch(() => {})
  }

  const upload = (chunk: CapturedChunk) => {
    // A capture let go after a cancelled start hands over nothing.
    if (cancelled()) return
    const params = {
      meetingId,
      n: chunk.n,
      start: chunk.start,
      duration: chunk.duration,
      audio: base64(chunk.wav),
    }
    const sent = (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await meetingCap.chunk(remote, params)
          return
        } catch (e) {
          // Main refuses a chunk number it already has: an earlier try got
          // there, though its answer did not get back.
          if (attempt > 1 && /chunk \d+ is already in/.test(message(e))) return
          if (attempt >= TRIES) return lost(chunk, e)
          await wait(RETRY_MS * attempt)
        }
      }
    })()
    uploads.add(sent)
    void sent.finally(() => uploads.delete(sent))
  }

  let started: Capture
  try {
    started = await startCapture({
      microphone: args.microphone,
      system: args.system,
      onChunk: upload,
      onLevel: (level) => set(levelAtom, level),
    })
  } catch (e) {
    // The meeting exists but will never hear anything: close it.
    void meetingCap.stop(remote, { meetingId }).catch(() => {})
    if (!cancelled()) set(recorderAtom, { ...IDLE, error: captureError(e) })
    return
  }
  if (cancelled()) {
    void started.stop().catch(() => {})
    void meetingCap.stop(remote, { meetingId }).catch(() => {})
    return
  }
  capture = started
  set(recorderAtom, (s) => ({
    ...s,
    phase: 'recording',
    startedAt: Date.now(),
    sources: started.sources,
    warning: started.problems.length === 0 ? null : `${started.problems.join('. ')}.`,
  }))
})

export const stopRecordingAtom = atom(null, async (get, set): Promise<void> => {
  const s = get(recorderAtom)
  if (s.phase === 'starting') {
    // The start sees this and lets go of what it gets from here on.
    generation++
    set(levelAtom, 0)
    set(recorderAtom, IDLE)
    return
  }
  if (s.phase !== 'recording' || s.meetingId === null || s.remote === null) return
  set(recorderAtom, { ...s, phase: 'stopping' })
  // A chunk that never arrived leaves a gap; after the stop, say so once.
  let error =
    s.failedUploads === 0
      ? null
      : `${s.failedUploads} chunk${s.failedUploads === 1 ? '' : 's'} never reached Holi; the transcript has gaps there.`
  const running = capture
  capture = null
  try {
    await running?.stop()
  } catch (e) {
    error = `The last few seconds may be missing: ${message(e)}`
  }
  await Promise.allSettled([...uploads])
  try {
    await meetingCap.stop(s.remote, { meetingId: s.meetingId })
    // The view turns to the review at once; main's next word fills it in.
    set(markStoppedAtom, s.meetingId)
  } catch (e) {
    error = `The meeting didn’t close cleanly: ${message(e)}`
  }
  set(levelAtom, 0)
  set(recorderAtom, { ...IDLE, error })
})
