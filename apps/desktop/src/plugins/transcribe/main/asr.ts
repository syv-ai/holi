/**
 * One chunk to the speech service's `/audio/transcriptions`: syv.ai's batch
 * endpoint by default, where a self-contained clip of a few seconds decodes
 * in about a second, which is what makes chunked uploads live captions; or
 * any service that answers OpenAI's form of it (`speech-service.ts`).
 *
 * syv.ai's own fields (`diarize`, `vocab`) go to syv.ai alone; another
 * service gets the words to get right as OpenAI's `prompt`, and no
 * `Authorization` without a key, as a local server wants. The key is the one
 * `speech-key.ts` resolves. Main makes the request itself: the key never
 * crosses to the renderer.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { SpeechService } from '../shared/meeting'
import { endpointOf, isSyv, SYV_MODELS_URL } from './speech-service'
import type { AsrSegment } from './stitcher'
import { encodeWav } from './wav'

/** A chunk is seconds of audio; an answer slower than this is a hung request. */
const TIMEOUT_MS = 60_000
/** A test answers at once; past this the service is not there. */
const CHECK_TIMEOUT_MS = 15_000

export interface AsrRequest {
  service: SpeechService
  /** The mono WAV to transcribe. */
  wav: Uint8Array
  /** None for a service that takes requests without one. */
  apiKey: string | null
  model: string
  /** 'auto' sends no language: the service detects it. */
  language: 'da' | 'en' | 'auto'
  /** Ask syv.ai for speaker labels (one microphone in a room). */
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
  if (isSyv(req.service)) {
    form.append('diarize', req.diarize ? 'on' : 'off')
    if (req.vocab.length > 0) form.append('vocab', req.vocab.join(', '))
  } else if (req.vocab.length > 0) {
    form.append('prompt', req.vocab.join(', '))
  }
  return form
}

const auth = (key: string | null): Record<string, string> =>
  key === null || key === '' ? {} : { Authorization: `Bearer ${key}` }

/** The segments the service heard. Throws with the status and the start of
 *  the answer when it refuses. */
export async function transcribe(fetchImpl: Fetch, req: AsrRequest): Promise<AsrSegment[]> {
  const res = await fetchImpl(endpointOf(req.service), {
    method: 'POST',
    headers: auth(req.apiKey),
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

/** Half a second of silence, 16 kHz mono 16-bit: what a test sends a
 *  service with no free way to ask about a key. */
const silence = (): Uint8Array => encodeWav(16_000, [new Int16Array(8000)])

/** Whether the service takes requests with this key: syv.ai's free model
 *  list (no credits, no audio), else half a second of silence. */
export async function checkService(
  fetchImpl: Fetch,
  service: SpeechService,
  apiKey: string | null,
): Promise<'ok' | 'invalid' | 'unreachable'> {
  try {
    const res = isSyv(service)
      ? await fetchImpl(SYV_MODELS_URL, {
          method: 'GET',
          headers: auth(apiKey),
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        })
      : await fetchImpl(endpointOf(service), {
          method: 'POST',
          headers: auth(apiKey),
          body: asrForm({
            service,
            wav: silence(),
            apiKey,
            model: service.model ?? '',
            language: 'auto',
            diarize: false,
            vocab: [],
            duration: 0.5,
          }),
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        })
    if (res.ok) return 'ok'
    return res.status === 401 || res.status === 403 ? 'invalid' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}
