/**
 * The two sides of a meeting, run together: the renderer's encoding and its
 * typed client on one end, the real capability registry and engine on the
 * other, with only the speech service, the agent and the vault faked. Each
 * call crosses as the IPC carries it (params as JSON, results cloned), so a
 * verb, a param or a result shape that drifts between the surface and the
 * engine fails here rather than in a meeting.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CapClient } from '@/plugin-api'
import { jsonFileStore } from '../../../main/plugin-api'
import { resolveArgv } from '../../../main/bridge/cli'
import {
  createCapabilityRegistry,
  type CapabilityContext,
} from '../../../main/capabilities/registry'
import type { Fetch } from '../main/asr'
import { meetingCapabilities, MEETING_NAMESPACES } from '../main/capabilities'
import { createProfiles, parseProfilesFile, profileParam } from '../main/profiles'
import { encodeWav } from '../renderer/audio/wav'
import { base64, profileId } from '../renderer/format'
import type { MeetingState, MeetingSummary } from '../shared/meeting'
import { engineRig, SCRIBE, until } from './engine-helpers'
import { meeting as uiMeeting, profile as uiProfile } from './meeting-fixture'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const REMOTE = 'syv/vault'
const RATE = 16_000
const BUILD = 'b0b0b0b0'

/** Eight seconds as the capture closes them: the microphone talks for the
 *  first four, the computer for the last four. */
function stereoChunk(): ArrayBuffer {
  const left = new Float32Array(8 * RATE)
  const right = new Float32Array(8 * RATE)
  for (let i = 0; i < left.length; i++) {
    const tone = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE)
    if (i < 4 * RATE) left[i] = tone
    else right[i] = tone
  }
  return encodeWav([left, right], RATE)
}

/** The speech service: one line in each half of the chunk. */
const service = vi.fn<Fetch>(async () =>
  Response.json({
    text: '',
    segments: [
      { start: 0.5, end: 3.5, text: 'Can we export the board to CSV?' },
      { start: 4.5, end: 7.5, text: 'Yes, finance has asked for that.' },
    ],
  }),
)

async function rig() {
  const userData = await mkdtemp(join(tmpdir(), 'holi-meetings-'))
  const profiles = createProfiles(
    jsonFileStore(join(userData, 'meeting-profiles.json'), parseProfilesFile),
  )
  const engine = await engineRig({
    profiles,
    fetch: service,
    userData,
    launch: async (args) => ({
      ok: true,
      sessionId: args.name.startsWith('Build') ? BUILD : SCRIBE,
    }),
  })
  const registry = createCapabilityRegistry()
  registry.register(
    MEETING_NAMESPACES,
    meetingCapabilities({
      meetings: engine.meetings,
      profiles,
      speechKey: {} as never,
      remote: REMOTE,
    }),
  )
  const ctx = { remote: REMOTE, root: engine.root, bundle: null } as CapabilityContext

  // The renderer's client, typed as `meeting-cap.ts` types it, over the
  // registry instead of tRPC: params go as JSON, results come back cloned.
  const client = new Proxy(
    {},
    {
      get:
        (_target, verb: string) =>
        async (remote: string, params?: unknown): Promise<unknown> => {
          const json = params === undefined ? undefined : JSON.parse(JSON.stringify(params))
          const { value } = await registry.run(`meeting.${verb}`, 'ui', { ...ctx, remote }, json)
          return structuredClone(value)
        },
    },
  ) as CapClient<ReturnType<typeof meetingCapabilities>>

  /** A `holi meeting …` command from inside the scribe's session. */
  const holi = async (argv: string[], stdin: string | null = null) => {
    const request = resolveArgv(['meeting', ...argv], registry.commands(), stdin, SCRIBE)
    if (request.kind !== 'run') throw new Error(`not a run: ${JSON.stringify(request)}`)
    return registry.run(request.name, 'cli', ctx, request.params)
  }

  const heard = <T>(name: 'meeting' | 'meetings'): T | undefined =>
    engine.emitted.filter(([n]) => n === name).at(-1)?.[1] as T | undefined

  return { ...engine, client, holi, heard }
}

it('a profile the editor saves comes back as it was sent, and its id is one main takes', async () => {
  const r = await rig()
  const sent = { ...uiProfile, asrModel: 'syvai/hviske-v5.3', roomDiarize: false }
  expect(await r.client['profiles.save'](REMOTE, { profile: sent })).toEqual(sent)
  expect(await r.client['profiles.list'](REMOTE)).toEqual([
    expect.objectContaining({ id: 'default' }),
    sent,
  ])

  const long = 'The weekly product planning sync with design, finance and the platform team'
  const id = profileId(long, [])
  expect(() => profileParam({ ...uiProfile, id })).not.toThrow()

  await r.client['profiles.delete'](REMOTE, { id: 'default' })
  await r.client['profiles.delete'](REMOTE, { id: sent.id })
  // With none left, main answers its default, which the editor then shows.
  expect((await r.client['profiles.list'](REMOTE)).map((p) => p.id)).toEqual(['default'])
})

it('a recorded chunk becomes Me and Them lines in a group the scribe writes, and a task sent from it answers a session', async () => {
  const r = await rig()
  await r.client['profiles.save'](REMOTE, {
    profile: { ...uiProfile, asrModel: 'syvai/hviske-v5.3' },
  })

  // Record: start, then a chunk as the recorder uploads it.
  const { meetingId } = await r.client.start(REMOTE, {
    profileId: uiProfile.id,
    title: uiMeeting.title,
  })
  await until(async () => (await r.client.get(REMOTE, { meetingId })).scribeSessionId === SCRIBE)
  const chunk = stereoChunk()
  expect(
    await r.client.chunk(REMOTE, { meetingId, n: 0, start: 0, duration: 8, audio: base64(chunk) }),
  ).toEqual({ ok: true })
  await until(async () => (await r.client.get(REMOTE, { meetingId })).segments.length === 2)

  // The profile reached the speech service.
  const form = service.mock.calls[0]![1].body as FormData
  expect(form.get('model')).toBe('syvai/hviske-v5.3')
  expect(form.get('language')).toBe(uiProfile.language)

  const state = await r.client.get(REMOTE, { meetingId })
  expect(state.segments).toEqual([
    {
      i: 0,
      speaker: 'Me',
      start: 0.5,
      end: 3.5,
      text: 'Can we export the board to CSV?',
      chunk: 0,
    },
    {
      i: 1,
      speaker: 'Them',
      start: 4.5,
      end: 7.5,
      text: 'Yes, finance has asked for that.',
      chunk: 0,
    },
  ])
  expect(state.chunks).toEqual([
    expect.objectContaining({ n: 0, start: 0, duration: 8, state: 'done', tries: 1 }),
  ])
  // The scribe, at the CLI door, once a batch has carried it the lines.
  r.meetings.scribe.hearSessions([{ id: SCRIBE, state: 'idle' }])
  await r.client.summarise(REMOTE, { meetingId })
  await until(async () => (await r.client.get(REMOTE, { meetingId })).scribeCursor === 1)
  const written = await r.holi(
    ['group'],
    JSON.stringify({
      startIndex: 0,
      title: 'Export to CSV',
      keywords: ['csv', 'finance'],
      summary: ['Finance asked for a CSV export of the board'],
      suggestions: [
        { kind: 'feature', title: 'Export to CSV', why: 'Finance asked.', segments: [0, 1] },
      ],
    }),
  )
  expect(JSON.parse(written.text)).toMatchObject({ startIndex: 0, lines: [0, 1], open: true })
  expect((await r.holi(['context'])).text).toContain('0\tExport to CSV\t(open)')

  let m = await r.client.get(REMOTE, { meetingId })
  expect(m.minutes).toBe('## Topics\n\n### Now: Export to CSV (from 0:00)\n')
  // The surface's fixture is a meeting mid-call: this one has its fields.
  expect(Object.keys(m).sort()).toEqual(Object.keys(uiMeeting).sort())
  expect(m.topics[0]!.suggestions).toEqual([
    { id: 's1', kind: 'feature', title: 'Export to CSV', why: 'Finance asked.', segments: [0, 1] },
  ])

  // Send the suggestion: the panel finds related lines, then makes the task and sends it.
  const related = await r.client.related(REMOTE, { meetingId, query: 'CSV', exclude: [0, 1] })
  expect(related).toEqual([])
  const task = await r.client['task.create'](REMOTE, {
    meetingId,
    lines: [0, 1],
    prompt: 'Export to CSV\nFinance asked.',
    kind: 'feature',
    from: { topicId: 't0', suggestionId: 's1' },
  })
  expect(task).toMatchObject({
    id: 'c1',
    status: 'accepted',
    origin: 'person',
    // Copied from the transcript by code.
    quotes: [
      { i: 0, speaker: 'Me', start: 0.5, text: 'Can we export the board to CSV?' },
      { i: 1, speaker: 'Them', start: 4.5, text: 'Yes, finance has asked for that.' },
    ],
  })
  // A person's patch: the task main answers is the one the surface puts.
  const owned = await r.client.card(REMOTE, { meetingId, cardId: 'c1', patch: { owner: 'Anna' } })
  expect(owned).toMatchObject({ id: 'c1', owner: 'Anna' })

  // Send: the session id the surface hands to "show this session".
  const { sessionId } = await r.client.build(REMOTE, { meetingId, cardId: 'c1' })
  expect(sessionId).toBe(BUILD)
  m = await r.client.get(REMOTE, { meetingId })
  expect(m.cards[0]).toMatchObject({ status: 'building', buildSessionId: BUILD })
  expect(m.cards[0]!.taskPath).toMatch(/^Meetings\/.+\/task\..+\.local\.md$/)

  // What the surface hears: the meeting, and the list.
  await until(() => r.heard<MeetingState>('meeting')?.cards[0]?.status === 'building')
  expect(r.heard<MeetingState>('meeting')).toEqual(m)
  expect(r.heard<MeetingSummary[]>('meetings')).toEqual(await r.client.list(REMOTE))
  expect((await r.client.list(REMOTE))[0]).toEqual({
    id: meetingId,
    title: uiMeeting.title,
    startedAt: m.startedAt,
    phase: 'recording',
    cards: 1,
    folder: m.folder,
  })

  // Stop, as the recorder does once every upload has settled: main finishes
  // on its own, and a late chunk is refused.
  expect(await r.client.stop(REMOTE, { meetingId })).toEqual({ ok: true })
  expect((await r.client.get(REMOTE, { meetingId })).phase).toBe('finishing')
  await expect(
    r.client.chunk(REMOTE, { meetingId, n: 1, start: 8, duration: 8, audio: base64(chunk) }),
  ).rejects.toThrow('not recording')
  await until(async () => {
    r.meetings.scribe.hearTurnEnd(SCRIBE)
    return (await r.client.get(REMOTE, { meetingId })).phase === 'done'
  })
  expect(r.heard<MeetingSummary[]>('meetings')?.[0]).toMatchObject({
    id: meetingId,
    phase: 'done',
  })
})
