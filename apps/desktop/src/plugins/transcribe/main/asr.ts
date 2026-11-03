/**
 * One chunk to syv.ai's transcription endpoint, the batch one the seeded
 * Transcribe app uses: a self-contained clip of a few seconds decodes in
 * about a second, which is what makes chunked uploads live captions.
 *
 * The endpoint is pinned here, and the key is the one `speech-key.ts`
 * resolves: this machine's, else the vault's `SYV_API_KEY`. Main makes the
 * request itself: the key never crosses to the renderer.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { AsrSegment } from './stitcher'

const BASE = 'https://platform.syv.ai/v1'
/** @public exported for its test */
export const ASR_URL = `${BASE}/audio/transcriptions`
/** The model list: free, so asking it costs no credits. @public exported for its test */
export const MODELS_URL = `${BASE}/models`
/** A chunk is seconds of audio; an answer slower than this is a hung request. */
const TIMEOUT_MS = 60_000
/** The model list answers at once; past this the service is not there. */
const CHECK_TIMEOUT_MS = 15_000

export interface AsrRequest {
  /** The mono WAV to transcribe. */
  wav: Uint8Array
  apiKey: string
  model: string
  /** 'auto' sends no language: the service detects it. */
  language: 'da' | 'en' | 'auto'
  /** Ask the service for speaker labels (one microphone in a room). */
  diarize: boolean
  /** Words to get right: the profile's glossary terms. */
  vocab: readonly string[]
  /** Seconds of audio, for a service that answers text without segments. */
  duration: number
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** The service refused a request. `status` is HTTP's; a 401 or 403 is the
 *  key, which no retry fixes. */
class AsrError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'AsrError'
  }
}

/** Whether a refusal is the key's: missing, wrong or revoked. */
export const keyRefused = (err: unknown): boolean =>
  err instanceof AsrError && (err.status === 401 || err.status === 403)

/** The multipart body, as the service reads it. */
function asrForm(req: AsrRequest): FormData {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(req.wav)], { type: 'audio/wav' }), 'chunk.wav')
  form.append('model', req.model)
  if (req.language !== 'auto') form.append('language', req.language)
  form.append('response_format', 'verbose_json')
  form.append('temperature', '0')
  form.append('diarize', req.diarize ? 'on' : 'off')
  if (req.vocab.length > 0) form.append('vocab', req.vocab.join(', '))
  return form
}

/** The segments the service heard. Throws with the status and the start of
 *  the answer when it refuses. */
export async function transcribe(fetchImpl: Fetch, req: AsrRequest): Promise<AsrSegment[]> {
  const res = await fetchImpl(ASR_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${req.apiKey}` },
    body: asrForm(req),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200)
    throw new AsrError(
      `transcription failed: ${res.status} ${res.statusText} ${body}`.trim(),
      res.status,
    )
  }
  const data = (await res.json()) as { segments?: unknown; text?: unknown }
  const raw = Array.isArray(data.segments) ? (data.segments as Record<string, unknown>[]) : []
  const segments = raw.flatMap((s): AsrSegment[] =>
    typeof s.text === 'string'
      ? [
          {
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
            text: s.text,
            speaker: s.speaker ?? s.speaker_id ?? s.label,
            ...(typeof s.compression_ratio === 'number'
              ? { compression: s.compression_ratio }
              : {}),
          },
        ]
      : [],
  )
  if (segments.length === 0 && typeof data.text === 'string' && data.text.trim() !== '') {
    return [{ start: 0, end: req.duration, text: data.text }]
  }
  return segments
}

/** What the service says of a key, asked of the free model list: no credits
 *  spent and no audio sent. */
export async function checkKey(
  fetchImpl: Fetch,
  apiKey: string,
): Promise<'ok' | 'invalid' | 'unreachable'> {
  try {
    const res = await fetchImpl(MODELS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (res.ok) return 'ok'
    return res.status === 401 || res.status === 403 ? 'invalid' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}
