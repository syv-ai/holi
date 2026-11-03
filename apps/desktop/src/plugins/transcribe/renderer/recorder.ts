/**
 * The recording controller: one meeting being recorded, held at module level
 * and in atoms rather than in the surface, so moving to another tab keeps it
 * recording.
 *
 * Record starts the meeting in main (`meeting.start`), then the capture, whose
 * chunks go to `meeting.chunk` as they close. Stop stops the capture (which
 * hands over its last partial chunk), waits for every upload, then stops the
 * meeting. A chunk that fails to reach main is retried, then counted and
 * shown; it never stops the recording.
 */
import { atom } from 'jotai'
import { activeRemoteAtom } from '@/plugin-api'
import type { Capture, CapturedChunk } from '../shared/meeting'
import { startCapture } from './audio/capture'
import { base64 } from './format'
import { meetingCap } from './meeting-cap'
import { markStoppedAtom, message, shownMeetingIdAtom } from './state'

export interface RecorderState {
  phase: 'idle' | 'starting' | 'recording' | 'stopping'
  meetingId: string | null
  remote: string | null
  /** Epoch ms the capture started. */
  startedAt: number | null
  /** The last thing that went wrong, in words to show; kept after a stop. */
  error: string | null
  /** Chunks that never reached main. */
  failedUploads: number
}

const IDLE: RecorderState = {
  phase: 'idle',
  meetingId: null,
  remote: null,
  startedAt: null,
  error: null,
  failedUploads: 0,
}

export const recorderAtom = atom<RecorderState>(IDLE)

/** The capture's loudness, 0..1, about 20 times a second. Its own atom, so
 *  only the meter re-renders that often. */
export const levelAtom = atom(0)

/** Whether a meeting is being recorded (or started, or stopped). */
export const recordingAtom = atom((get) => get(recorderAtom).phase !== 'idle')

export const clearRecorderErrorAtom = atom(null, (_get, set) =>
  set(recorderAtom, (s) => ({ ...s, error: null })),
)

let capture: Capture | null = null
const uploads = new Set<Promise<void>>()

/** Tries per chunk, and the wait before each retry. */
const TRIES = 3
const RETRY_MS = 300

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Why the capture did not start, as the person can act on it. */
function captureError(e: unknown): string {
  if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
    return 'Holi may not record here. Allow the microphone (and screen recording, for computer audio) in System Settings › Privacy & Security, then press Record again.'
  }
  return `Recording didn’t start: ${message(e)}`
}

export interface StartArgs {
  profileId: string
  title: string
  microphone: boolean
  system: boolean
}

export const startRecordingAtom = atom(null, async (get, set, args: StartArgs): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (get(recorderAtom).phase !== 'idle' || remote === null) return
  set(recorderAtom, { ...IDLE, phase: 'starting', remote })

  let meetingId: string
  try {
    const title = args.title.trim()
    ;({ meetingId } = await meetingCap.start(remote, {
      profileId: args.profileId,
      ...(title === '' ? {} : { title }),
    }))
  } catch (e) {
    set(recorderAtom, { ...IDLE, error: `The meeting didn’t start: ${message(e)}` })
    return
  }
  set(recorderAtom, (s) => ({ ...s, meetingId }))
  set(shownMeetingIdAtom, meetingId)

  const upload = (chunk: CapturedChunk) => {
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
          if (attempt >= TRIES) {
            set(recorderAtom, (s) =>
              s.meetingId === meetingId
                ? {
                    ...s,
                    failedUploads: s.failedUploads + 1,
                    error: `Chunk ${chunk.n} didn’t reach Holi: ${message(e)}. Still recording.`,
                  }
                : s,
            )
            return
          }
          await wait(RETRY_MS * attempt)
        }
      }
    })()
    uploads.add(sent)
    void sent.finally(() => uploads.delete(sent))
  }

  try {
    capture = await startCapture({
      microphone: args.microphone,
      system: args.system,
      onChunk: upload,
      onLevel: (level) => set(levelAtom, level),
    })
  } catch (e) {
    // The meeting exists but will never hear anything: close it.
    void meetingCap.stop(remote, { meetingId }).catch(() => {})
    set(recorderAtom, { ...IDLE, error: captureError(e) })
    return
  }
  set(recorderAtom, (s) => ({ ...s, phase: 'recording', startedAt: Date.now() }))
})

export const stopRecordingAtom = atom(null, async (get, set): Promise<void> => {
  const s = get(recorderAtom)
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
