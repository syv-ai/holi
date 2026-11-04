/**
 * `meeting.key.*` through the real registry, over a real engine and the real
 * key store (with `safeStorage` faked): what a pasted key must look like,
 * that saving one sends the audio that waited for it, and that the key never
 * comes back out, in a result or in an event.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityError } from '../../../main/capabilities/error'
import {
  createCapabilityRegistry,
  type CapabilityContext,
} from '../../../main/capabilities/registry'
import type { MeetingState } from '../shared/meeting'
import type { Fetch } from '../main/asr'
import { endpointOf, SYV_MODELS_URL as MODELS_URL, SYV_SERVICE } from '../main/speech-service'
import { meetingCapabilities, MEETING_NAMESPACES } from '../main/capabilities'
import type { Meetings } from '../main/engine'
import { createSpeechKey, createSpeechKeyStore } from '../main/speech-key'
import { chunkWav, engineRig, settle, until } from './engine-helpers'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const GOOD = 'hv_good0123456789abcdefghijklmnopq'
const REVOKED = 'hv_revoked0123456789abcdefghijklm'

const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buf: Buffer) => buf.toString().replace(/^enc:/, ''),
}

/** The service: the good key transcribes and lists models, any other is a 401. */
const service: Fetch = async (url, init) => {
  const auth = (init.headers as Record<string, string>)['Authorization']
  if (auth !== `Bearer ${GOOD}`) {
    return new Response('{"error":{"message":"Invalid API key"}}', { status: 401 })
  }
  if (url === MODELS_URL) return Response.json({ object: 'list', data: [] })
  if (url === endpointOf(SYV_SERVICE))
    return Response.json({ segments: [{ start: 0, end: 2, text: 'Hej' }] })
  return new Response('', { status: 404 })
}

async function rig(vaultEnv: Record<string, string> = {}) {
  const userData = await mkdtemp(join(tmpdir(), 'holi-key-'))
  let meetings: Meetings | null = null
  const fetch = vi.fn(service)
  const speechKey = createSpeechKey({
    store: createSpeechKeyStore(join(userData, 'speech-key.enc'), storage),
    vaultEnv: async () => vaultEnv,
    service: async () => SYV_SERVICE,
    fetch,
    changed: () => meetings?.wake(),
  })
  const engine = await engineRig({ userData, fetch, apiKey: () => speechKey.resolve() })
  meetings = engine.meetings
  const registry = createCapabilityRegistry()
  registry.register(
    MEETING_NAMESPACES,
    meetingCapabilities({
      meetings: engine.meetings,
      profiles: { list: async () => [engine.profile] } as never,
      speechKey,
      services: { get: async () => ({ url: null, model: null }), set: async (s) => s },
      serviceChanged: () => {},
      remote: 'syv/vault',
    }),
  )
  const ctx = { remote: 'syv/vault', root: engine.root, bundle: null } as CapabilityContext
  /** Every result as it was serialized, to search for the key afterwards. */
  const results: unknown[] = []
  const ui = async (name: string, params: unknown = {}) => {
    const { value } = await registry.run(name, 'ui', ctx, params)
    results.push(JSON.stringify(value))
    return value
  }
  return { ...engine, registry, ui, results, fetch }
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a refusal')
    },
    (err: unknown) => {
      if (!(err instanceof CapabilityError)) throw err
      return err.code
    },
  )

describe('the key verbs', () => {
  it('are the UI’s alone', async () => {
    const r = await rig()
    const names = r.registry.names('ui').filter((n) => n.startsWith('meeting.key.'))
    expect(names.sort()).toEqual([
      'meeting.key.clear',
      'meeting.key.set',
      'meeting.key.status',
      'meeting.key.test',
    ])
    expect(r.registry.names('cli').filter((n) => n.startsWith('meeting.key.'))).toEqual([])
    expect(r.registry.names('app')).toEqual([])
  })

  it('check a pasted key: trimmed, one line, no spaces, a plausible length', async () => {
    const r = await rig()
    for (const key of [
      '',
      '   ',
      `${GOOD}\nsecond line`,
      'hv_has a space inside it',
      'short',
      `hv_${'x'.repeat(600)}`,
      42,
    ]) {
      expect(await refusal(r.ui('meeting.key.set', { key }))).toBe('BAD_REQUEST')
    }
    expect(await r.ui('meeting.key.status')).toEqual({
      set: false,
      source: null,
      service: { url: null, model: null },
      ready: false,
    })

    // A key of another shape is the service's to judge, not Holi's.
    await r.ui('meeting.key.set', { key: 'sk-some-other-shape-0123' })
    await r.ui('meeting.key.set', { key: `  ${GOOD}\n` })
    expect(await r.ui('meeting.key.status')).toEqual({
      set: true,
      source: 'app',
      service: { url: null, model: null },
      ready: true,
    })
    expect(await r.ui('meeting.key.test')).toEqual({ result: 'ok' })
  })

  it('say where the key comes from, the vault’s env after the app’s', async () => {
    const r = await rig({ SYV_API_KEY: REVOKED })
    expect(await r.ui('meeting.key.status')).toEqual({
      set: true,
      source: 'vault',
      service: { url: null, model: null },
      ready: true,
    })
    expect(await r.ui('meeting.key.test')).toEqual({ result: 'invalid' })
    await r.ui('meeting.key.set', { key: GOOD })
    expect(await r.ui('meeting.key.status')).toEqual({
      set: true,
      source: 'app',
      service: { url: null, model: null },
      ready: true,
    })
    await r.ui('meeting.key.clear')
    expect(await r.ui('meeting.key.status')).toEqual({
      set: true,
      source: 'vault',
      service: { url: null, model: null },
      ready: true,
    })
  })
})

describe('saving a key', () => {
  it('sends the audio recorded without one', async () => {
    const r = await rig()
    const { meetingId } = (await r.ui('meeting.start', { profileId: 'default' })) as {
      meetingId: string
    }
    const meeting = (await r.ui('meeting.get', { meetingId })) as MeetingState
    for (const n of [0, 1]) {
      await r.ui('meeting.chunk', {
        meetingId,
        n,
        start: n * 8,
        duration: 8,
        audio: Buffer.from(chunkWav(8)).toString('base64'),
      })
    }
    await until(() => meeting.blocked === 'no-key')
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(r.fetch).not.toHaveBeenCalled()

    await r.ui('meeting.key.set', { key: GOOD })
    await until(() => meeting.segments.length === 2)
    expect(meeting.blocked).toBeUndefined()
  })

  it('never puts the key in a result or an event', async () => {
    const r = await rig()
    const { meetingId } = (await r.ui('meeting.start', { profileId: 'default' })) as {
      meetingId: string
    }
    const meeting = (await r.ui('meeting.get', { meetingId })) as MeetingState
    // A refused key first, then a good one.
    await r.ui('meeting.key.set', { key: REVOKED })
    await r.ui('meeting.chunk', {
      meetingId,
      n: 0,
      start: 0,
      duration: 8,
      audio: Buffer.from(chunkWav(8)).toString('base64'),
    })
    await until(() => meeting.blocked === 'bad-key')
    await r.ui('meeting.get', { meetingId })
    await r.ui('meeting.key.status')
    await r.ui('meeting.key.test')
    await r.ui('meeting.key.set', { key: GOOD })
    await until(() => meeting.segments.length === 1)
    await r.ui('meeting.key.status')
    await r.ui('meeting.key.test')
    await r.ui('meeting.get', { meetingId })
    await r.ui('meeting.key.clear')

    const said = JSON.stringify({ results: r.results, events: r.emitted })
    expect(said).toContain('bad-key')
    expect(said).not.toContain(GOOD)
    expect(said).not.toContain(REVOKED)
  })
})
