/**
 * The speech service: syv.ai's by default, or any service that answers
 * OpenAI's `/audio/transcriptions`, given by its address and model; what a
 * chunk sends each (syv.ai's own fields only to syv.ai, no key header without
 * a key), and how a key is tested without a free model list.
 */
import { describe, expect, it, vi } from 'vitest'
import { CapabilityError } from '../../../main/capabilities/error'
import { checkService, transcribe, type Fetch } from '../main/asr'
import { endpointOf, parseServiceFile, serviceParam, SYV_SERVICE } from '../main/speech-service'

const LOCAL = { url: 'http://localhost:8000/v1', model: 'whisper-large-v3' }

const refused = (raw: Record<string, unknown>): string => {
  try {
    serviceParam(raw)
  } catch (err) {
    if (err instanceof CapabilityError) return err.message
    throw err
  }
  throw new Error('expected a refusal')
}

describe('a speech service', () => {
  it('is syv.ai’s without an address, else an https one, or http on this machine, with a model', () => {
    expect(serviceParam({})).toEqual(SYV_SERVICE)
    expect(serviceParam({ url: '' })).toEqual(SYV_SERVICE)
    expect(serviceParam({ url: 'https://api.example.com/v1/', model: 'whisper-1' })).toEqual({
      url: 'https://api.example.com/v1',
      model: 'whisper-1',
    })
    expect(serviceParam(LOCAL)).toEqual(LOCAL)
    expect(refused({ url: 'http://example.com/v1', model: 'm' })).toContain('https')
    expect(refused({ url: 'https://example.com/v1' })).toContain('model')
    expect(refused({ url: 'https://me:secret@example.com', model: 'm' })).toContain('key field')
    expect(refused({ url: 'not an address', model: 'm' })).toContain('not an address')
  })

  it('posts to /audio/transcriptions, added to a base address', () => {
    expect(endpointOf(SYV_SERVICE)).toBe('https://platform.syv.ai/v1/audio/transcriptions')
    expect(endpointOf(LOCAL)).toBe('http://localhost:8000/v1/audio/transcriptions')
    expect(endpointOf({ url: 'https://x.test/v1/audio/transcriptions', model: 'm' })).toBe(
      'https://x.test/v1/audio/transcriptions',
    )
  })

  it('on disk that does not check out is syv.ai’s', () => {
    expect(parseServiceFile(null)).toEqual(SYV_SERVICE)
    expect(parseServiceFile({ url: 'ftp://x', model: 'm' })).toEqual(SYV_SERVICE)
    expect(parseServiceFile(LOCAL)).toEqual(LOCAL)
  })
})

describe('a chunk to another service', () => {
  it('sends OpenAI’s fields, the words to get right as its prompt, and no key header without a key', async () => {
    const fetch = vi.fn<Fetch>(async () => Response.json({ text: 'Hej', segments: [] }))
    const segments = await transcribe(fetch, {
      service: LOCAL,
      wav: new Uint8Array([1, 2]),
      apiKey: null,
      model: 'whisper-large-v3',
      language: 'da',
      diarize: true,
      vocab: ['Holi', 'Hviske'],
      duration: 4,
    })
    expect(segments).toEqual([{ start: 0, end: 4, text: 'Hej' }])
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://localhost:8000/v1/audio/transcriptions')
    expect(init.headers).toEqual({})
    const form = init.body as FormData
    expect(form.get('model')).toBe('whisper-large-v3')
    expect(form.get('language')).toBe('da')
    expect(form.get('prompt')).toBe('Holi, Hviske')
    expect(form.get('diarize')).toBeNull()
    expect(form.get('vocab')).toBeNull()
  })

  it('to syv.ai sends its own fields and the key', async () => {
    const fetch = vi.fn<Fetch>(async () => Response.json({ segments: [] }))
    await transcribe(fetch, {
      service: SYV_SERVICE,
      wav: new Uint8Array([1]),
      apiKey: 'hv_key',
      model: 'syv-transcribe',
      language: 'auto',
      diarize: false,
      vocab: ['Holi'],
      duration: 1,
    })
    const init = fetch.mock.calls[0]![1]
    expect(init.headers).toEqual({ Authorization: 'Bearer hv_key' })
    const form = init.body as FormData
    expect(form.get('diarize')).toBe('off')
    expect(form.get('vocab')).toBe('Holi')
    expect(form.get('prompt')).toBeNull()
  })

  it('is tested with half a second of silence, refused keys told apart', async () => {
    const answers = [new Response('', { status: 200 }), new Response('', { status: 401 })]
    const fetch = vi.fn<Fetch>(async () => answers.shift()!)
    expect(await checkService(fetch, LOCAL, null)).toBe('ok')
    expect(await checkService(fetch, LOCAL, 'sk-wrong')).toBe('invalid')
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://localhost:8000/v1/audio/transcriptions')
    expect(((init.body as FormData).get('file') as Blob).size).toBe(44 + 16_000)
    const offline = vi.fn<Fetch>(async () => {
      throw new Error('connection refused')
    })
    expect(await checkService(offline, LOCAL, null)).toBe('unreachable')
  })
})
