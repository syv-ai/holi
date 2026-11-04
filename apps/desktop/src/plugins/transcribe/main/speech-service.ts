/**
 * The speech service this machine transcribes meetings with
 * (docs/features/meetings.md): syv.ai's by default, or any service that
 * answers OpenAI's `/audio/transcriptions` (a local Whisper server, a
 * hosted one), named by its address and model. Its key, when it needs one,
 * is the speech key (`speech-key.ts`), kept apart in the keychain.
 *
 * Kept on this machine in `userData`, like the profiles: a vault is shared,
 * and where a person's meeting audio goes is theirs to choose.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { CapabilityError, type JsonFileStore } from '../../../main/plugin-api'
import type { SpeechService } from '../shared/meeting'

/** syv.ai's API, which the default service is. */
const SYV_BASE = 'https://platform.syv.ai/v1'
const PATH = '/audio/transcriptions'
const MAX_URL = 500
const MAX_MODEL = 120

/** syv.ai's, which every machine starts with. */
export const SYV_SERVICE: SpeechService = { url: null, model: null }

/** Whether the service is syv.ai's, which takes its own fields (`diarize`,
 *  `vocab`), has a free model list to test a key with, and needs a key. */
export const isSyv = (s: SpeechService): boolean => s.url === null

/** The address a chunk is posted to: syv.ai's, or the service's, with
 *  `/audio/transcriptions` added when it was given as the API's base. */
export function endpointOf(s: SpeechService): string {
  const base = (s.url ?? SYV_BASE).replace(/\/+$/, '')
  return base.endsWith(PATH) ? base : `${base}${PATH}`
}

/** syv.ai's model list: free, so asking it spends no credits. */
export const SYV_MODELS_URL = `${SYV_BASE}/models`

/**
 * A service as the UI sent it: `url` null for syv.ai's, else an http(s)
 * address with a `model` to ask it for. Plain http only to this machine:
 * meeting audio does not cross a network unencrypted.
 */
export function serviceParam(raw: Record<string, unknown>): SpeechService {
  const url = raw['url'] ?? null
  if (url === null || url === '') return SYV_SERVICE
  if (typeof url !== 'string' || url.length > MAX_URL) bad('url must be an address')
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    bad('that is not an address, e.g. https://api.example.com/v1')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    bad('the address must be https, or http on this machine')
  }
  if (parsed.username !== '' || parsed.password !== '') bad('put the key in the key field')
  const model = typeof raw['model'] === 'string' ? raw['model'].trim() : ''
  if (model === '') bad('name the model the service should use')
  if (model.length > MAX_MODEL || /\s/.test(model)) bad('a model is one word, e.g. whisper-1')
  return { url: parsed.href.replace(/\/+$/, ''), model }
}

/** The file on disk, read leniently: anything that does not check out is
 *  syv.ai's. */
export function parseServiceFile(raw: unknown): SpeechService {
  if (typeof raw !== 'object' || raw === null) return SYV_SERVICE
  try {
    return serviceParam(raw as Record<string, unknown>)
  } catch {
    return SYV_SERVICE
  }
}

export interface SpeechServices {
  get(): Promise<SpeechService>
  set(service: SpeechService): Promise<SpeechService>
}

export function createSpeechServices(store: JsonFileStore<SpeechService>): SpeechServices {
  return {
    get: () => store.read(),
    set: (service) => store.update(() => service),
  }
}

function bad(message: string): never {
  throw new CapabilityError('BAD_REQUEST', message)
}
