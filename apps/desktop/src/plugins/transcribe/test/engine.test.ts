/**
 * The meeting engine: audio on disk before anything else, uploads and their
 * retries, what the service is asked, recovery after a crash, and the files
 * a meeting leaves in the vault. Fake time, a fake service, no network.
 */
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingState } from '../shared/meeting'
import type { Fetch } from '../main/asr'
import { endpointOf, SYV_SERVICE } from '../main/speech-service'
import { parseWav } from '../main/wav'
import { chunkWav, engineRig, SCRIBE, settle, settleUntil, until } from './engine-helpers'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const present = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

async function started(rig: Awaited<ReturnType<typeof engineRig>>, title = 'Planning') {
  const { meetingId } = await rig.meetings.start({ title, profileId: 'default' })
  const meeting = await rig.meetings.get(meetingId)
  const dir = join(rig.userData, 'meetings', meetingId)
  const send = (n: number, who: 'me' | 'them' = 'me') =>
    rig.meetings.chunk({ meetingId, n, start: n * 8, duration: 8, audio: chunkWav(8, who) })
  return { meetingId, meeting, dir, send }
}

const chunkStates = (m: MeetingState) => m.chunks.map((c) => c.state)

describe('a chunk', () => {
  it('is on disk, and in the saved state, before it is uploaded', async () => {
    let seen: { wav: boolean; state: string } | null = null
    const rig = await engineRig({
      fetch: async () => {
        const dir = join(rig.userData, 'meetings', id)
        seen = {
          wav: await present(join(dir, 'chunk-0.wav')),
          state: await readFile(join(dir, 'state.json'), 'utf8'),
        }
        return Response.json({ segments: [{ start: 0, end: 2, text: 'Hej' }] })
      },
    })
    const { meetingId: id, send, meeting } = await started(rig)
    await send(0)
    await until(() => meeting.chunks[0]?.state === 'done')
    expect(seen!.wav).toBe(true)
    expect(JSON.parse(seen!.state).meeting.chunks[0]).toMatchObject({ n: 0, start: 0 })
  })

  it('goes up as a mono mix with the profile’s model, language, speaker labels and vocabulary', async () => {
    const rig = await engineRig({
      profile: {
        asrModel: 'syvai/hviske-v5.3',
        language: 'da',
        glossary: [
          { term: 'Claude', heardAs: ['klod'] },
          { term: 'Holi', heardAs: [] },
        ],
      },
    })
    const { send, meeting } = await started(rig)
    await send(0)
    await until(() => meeting.chunks[0]?.state === 'done')
    expect(rig.service.fetch).toHaveBeenCalledWith(endpointOf(SYV_SERVICE), expect.anything())
    const init = rig.service.fetch.mock.calls[0]![1]
    expect(init.headers).toEqual({ Authorization: 'Bearer test-key' })
    const form = rig.service.forms[0]!
    expect(form.get('model')).toBe('syvai/hviske-v5.3')
    expect(form.get('language')).toBe('da')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('temperature')).toBe('0')
    expect(form.get('diarize')).toBe('off')
    expect(form.get('vocab')).toBe('Claude, Holi')
    const file = form.get('file') as Blob
    expect(parseWav(new Uint8Array(await file.arrayBuffer())).channels).toBe(1)
  })

  it('sends no language for auto, and asks for speaker labels in a room', async () => {
    const rig = await engineRig({ profile: { language: 'auto', roomDiarize: true } })
    const { send, meeting } = await started(rig)
    await send(0)
    await until(() => meeting.chunks[0]?.state === 'done')
    const form = rig.service.forms[0]!
    expect(form.has('language')).toBe(false)
    expect(form.get('diarize')).toBe('on')
    expect(form.get('model')).toBe('syv-transcribe')
    expect(form.has('vocab')).toBe(false)
    expect(meeting.segments[0]?.speaker).toBe('Speaker 1')
  })

  it('labels who spoke from the stereo audio, and times it from the meeting start', async () => {
    const rig = await engineRig()
    const { send, meeting } = await started(rig)
    await send(0, 'me')
    await send(1, 'them')
    await until(() => meeting.segments.length === 2)
    expect(meeting.segments.map((s) => [s.i, s.speaker, s.start, s.chunk])).toEqual([
      [0, 'Me', 0.5, 0],
      [1, 'Them', 8.5, 1],
    ])
    expect(meeting.chunks[0]?.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('is tried again after 1, 3, 9 and 27 seconds, then marked failed', async () => {
    let calls = 0
    const rig = await engineRig({
      fetch: async () => {
        calls++
        return new Response('busy', { status: 503 })
      },
    })
    const { send, meeting } = await started(rig)
    await send(0)
    const chunk = () => meeting.chunks[0]!
    await settleUntil(() => calls === 1 && chunk().state !== 'uploading')
    for (const [k, ms] of [1000, 3000, 9000, 27_000].entries()) {
      // A moment short of the wait, nothing; at the wait, the next try.
      await vi.advanceTimersByTimeAsync(ms - 1)
      await settle()
      expect(calls).toBe(k + 1)
      await vi.advanceTimersByTimeAsync(1)
      await settleUntil(() => calls === k + 2 && chunk().state !== 'uploading')
    }
    expect(chunk()).toMatchObject({
      state: 'failed',
      tries: 5,
      error: expect.stringContaining('503'),
    })
  })

  it('that failed is tried again when the meeting stops, and the meeting finishes', async () => {
    let down = true
    const rig = await engineRig({
      fetch: async () =>
        down
          ? new Response('down', { status: 502 })
          : Response.json({ segments: [{ start: 0, end: 2, text: 'Endelig.' }] }),
    })
    const { send, meeting, meetingId } = await started(rig)
    await send(0)
    await until(() => meeting.chunks[0]?.state === 'failed')
    down = false
    await rig.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    expect(chunkStates(meeting)).toEqual(['done'])
    expect(meeting.segments.map((s) => s.text)).toEqual(['Endelig.'])
  })

  it('that keeps failing after the stop leaves the rest of the transcript whole', async () => {
    const fetch: Fetch = async (_url, init) => {
      const file = (init.body as FormData).get('file') as Blob
      // Chunk 1 is a different length: fail it, always.
      return file.size > 300_000
        ? new Response('no', { status: 500 })
        : Response.json({ segments: [{ start: 0, end: 2, text: 'ok' }] })
    }
    const rig = await engineRig({ fetch })
    const { meeting, meetingId } = await started(rig)
    const put = (n: number, seconds: number) =>
      rig.meetings.chunk({
        meetingId,
        n,
        start: n * 8,
        duration: seconds,
        audio: chunkWav(seconds),
      })
    await put(0, 8)
    await put(1, 12)
    await put(2, 8)
    await until(() => meeting.chunks[1]?.state === 'failed')
    // Chunk 2 waits for chunk 1: indices are given in order only.
    expect(meeting.segments.map((s) => s.chunk)).toEqual([0])
    await rig.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    expect(meeting.segments.map((s) => [s.i, s.chunk])).toEqual([
      [0, 0],
      [1, 2],
    ])
  })
})

describe('the audio', () => {
  it('is deleted once transcribed', async () => {
    const rig = await engineRig()
    const { send, meeting, dir } = await started(rig)
    await send(0)
    await until(() => meeting.chunks[0]?.state === 'done')
    await until(async () => !(await present(join(dir, 'chunk-0.wav'))))
    expect(meeting.segments).toHaveLength(1)
  })

  it('is kept when the profile keeps audio', async () => {
    const rig = await engineRig({ profile: { keepAudio: true } })
    const { send, meeting, dir } = await started(rig)
    await send(0)
    await until(() => meeting.chunks[0]?.state === 'done')
    expect(await present(join(dir, 'chunk-0.wav'))).toBe(true)
  })
})

describe('after a crash', () => {
  it('a meeting left recording uploads every chunk on disk and finishes', async () => {
    const first = await engineRig({ fetch: async () => new Response('', { status: 500 }) })
    const { meetingId, dir } = await started(first, 'Crashed')
    // A chunk the state knows, and one written as the crash came.
    await first.meetings.chunk({
      meetingId,
      n: 0,
      start: 0,
      duration: 8,
      audio: chunkWav(8),
    })
    await first.meetings.dispose()
    await writeFile(join(dir, 'chunk-1.wav'), chunkWav(6, 'them'))
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    expect(state.meeting.phase).toBe('recording')

    const again = await engineRig({ userData: first.userData, root: first.root })
    const meeting = await again.meetings.get(meetingId)
    await until(() => meeting.phase === 'done')
    expect(meeting.chunks.map((c) => [c.n, c.start, c.duration, c.state])).toEqual([
      [0, 0, 8, 'done'],
      [1, 8, 6, 'done'],
    ])
    expect(meeting.segments.map((s) => [s.i, s.speaker])).toEqual([
      [0, 'Me'],
      [1, 'Them'],
    ])
    expect(again.meetings.list()).toEqual([
      expect.objectContaining({ id: meetingId, phase: 'done', title: 'Crashed' }),
    ])
    expect((await readdir(dir)).filter((f) => f.endsWith('.wav'))).toEqual([])
  })

  it('a meeting of another vault is not this one’s', async () => {
    const first = await engineRig()
    await started(first)
    await first.meetings.dispose()
    const dir = join(first.userData, 'meetings')
    const [id] = await readdir(dir)
    const path = join(dir, id!, 'state.json')
    const state = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...state, remote: 'someone/else' }))
    const again = await engineRig({ userData: first.userData })
    expect(again.meetings.list()).toEqual([])
    await expect(again.meetings.get(id!)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('the vault files', () => {
  it('are the transcript and private minutes, rendered from the groups, in the meeting’s folder', async () => {
    const rig = await engineRig({
      launch: async () => ({ ok: true, sessionId: SCRIBE }),
    })
    const { send, meeting } = await started(rig, 'Plan: Q1/Q2?')
    expect(meeting.folder).toMatch(/^Meetings\/\d{4}-\d\d-\d\d Plan Q1 Q2\.meeting$/)
    await send(0)
    await until(() => meeting.segments.length === 1)
    // The first line opens the first group, and the minutes show it as Now.
    expect(meeting.topics).toEqual([expect.objectContaining({ id: 't0', open: true })])
    await until(() => rig.writes.has(`${meeting.folder}/minutes.local.md`))
    expect(rig.writes.get(`${meeting.folder}/transcript.local.md`)).toContain(
      '**Mic audio** · 0:00',
    )
    expect(rig.writes.get(`${meeting.folder}/transcript.local.md`)).toContain('## Now · 0:00')
    expect(rig.writes.get(`${meeting.folder}/transcript.local.md`)).toContain('said 1')
    // A draft while it records, in the profile's language.
    expect(meeting.minutes).toMatch(
      /^# Plan: Q1\/Q2\?\n\n\d{4}-\d\d-\d\d · fra \d\d:\d\d\n\n> Udkast: /,
    )
    expect(meeting.minutes).toContain('## Drøftelse\n\n### Nu (fra 0:00)\n')
    expect(rig.writes.get(`${meeting.folder}/minutes.local.md`)).toBe(meeting.minutes)
  })

  it('share the minutes when the profile says so', async () => {
    const rig = await engineRig({
      profile: { shareMinutes: true },
      launch: async () => ({ ok: true, sessionId: SCRIBE }),
    })
    const { meeting, send } = await started(rig)
    await send(0)
    await until(() => rig.writes.has(`${meeting.folder}/minutes.md`))
    expect(rig.writes.has(`${meeting.folder}/minutes.local.md`)).toBe(false)
  })

  it('of a meeting saved before groups keep the minutes its scribe wrote', async () => {
    const first = await engineRig()
    const { meetingId, dir, send, meeting } = await started(first, 'Old')
    await send(0)
    await until(() => meeting.segments.length === 1)
    await first.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    await first.meetings.dispose()
    const path = join(dir, 'state.json')
    const state = JSON.parse(await readFile(path, 'utf8'))
    state.meeting.minutes = '## Status\n\n- The scribe wrote this'
    delete state.meeting.topics
    await writeFile(path, JSON.stringify(state))

    const again = await engineRig({ userData: first.userData, root: first.root })
    const old = await again.meetings.get(meetingId)
    expect(old.topics).toEqual([])
    await again.meetings.editSegment(meetingId, 0, 'Corrected')
    expect(old.minutes).toBe('## Status\n\n- The scribe wrote this')
  })

  it('read a group saved with a one-sentence summary as a list', async () => {
    const first = await engineRig()
    const { meetingId, dir, send, meeting } = await started(first)
    await send(0)
    await until(() => meeting.segments.length === 1)
    await first.meetings.dispose()
    const path = join(dir, 'state.json')
    const state = JSON.parse(await readFile(path, 'utf8'))
    state.meeting.phase = 'done'
    state.meeting.topics = [
      {
        id: 't0',
        title: 'Budget',
        summary: 'One line.',
        keywords: ['a', 'b'],
        lines: [0],
        start: 0,
        end: 2,
      },
    ]
    await writeFile(path, JSON.stringify(state))
    const again = await engineRig({ userData: first.userData, root: first.root })
    expect((await again.meetings.get(meetingId)).topics[0]).toMatchObject({
      summary: ['One line.'],
      open: false,
      decisions: [],
      questions: [],
      suggestions: [],
    })
  })

  it('a second meeting of the same name on the same day gets a folder of its own', async () => {
    const rig = await engineRig()
    const a = await started(rig, 'Standup')
    const b = await started(rig, 'Standup')
    expect(b.meeting.folder).toBe(a.meeting.folder.replace(/\.meeting$/, ' (2).meeting'))
  })

  it('the renderer hears the meeting, at most four times a second, and the list', async () => {
    const rig = await engineRig()
    const { send, meeting } = await started(rig)
    await send(0)
    await send(1)
    const heard = () => rig.emitted.filter(([name]) => name === 'meeting')
    await until(() => (heard().at(-1)?.[1] as MeetingState | undefined)?.segments.length === 2)
    const at = heard()
    expect(at.length).toBeGreaterThan(1)
    at.slice(1).forEach(([, , t], k) => expect(t - at[k]![2]).toBeGreaterThanOrEqual(250))
    const lists = rig.emitted.filter(([name]) => name === 'meetings')
    expect(lists.at(-1)![1]).toEqual([expect.objectContaining({ id: meeting.id, cards: 0 })])
  })
})

describe('where a meeting goes', () => {
  it('starts in the folder chosen, with this machine’s first profile when none is named', async () => {
    const rig = await engineRig()
    const { meetingId } = await rig.meetings.start({ title: 'Kickoff', folder: 'Clients/Acme' })
    const meeting = await rig.meetings.get(meetingId)
    expect(meeting.folder).toMatch(/^Clients\/Acme\/\d{4}-\d\d-\d\d Kickoff\.meeting$/)
    expect(meeting.profileId).toBe('default')
  })

  it('is a folder the New menu makes first, where Record then starts it', async () => {
    const rig = await engineRig()
    const { path } = await rig.meetings.prepare({ folder: 'Clients/Acme', title: 'Kickoff' })
    expect(path).toMatch(/^Clients\/Acme\/\d{4}-\d\d-\d\d Kickoff\.meeting$/)
    expect(rig.writes.get(`${path}/transcript.local.md`)).toContain('Not recorded yet')
    const { meetingId } = await rig.meetings.start({ title: 'Kickoff', path })
    expect((await rig.meetings.get(meetingId)).folder).toBe(path)
    await expect(rig.meetings.start({ path })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('starts in a folder made with a long title in any script', async () => {
    const rig = await engineRig()
    const title = '会議'.repeat(55)
    const { path } = await rig.meetings.prepare({ folder: 'Clients', title })
    const { meetingId } = await rig.meetings.start({ title, path })
    expect((await rig.meetings.get(meetingId)).folder).toBe(path)
  })

  it('starts in a placeholder written before placeholders had frontmatter', async () => {
    const rig = await engineRig()
    const path = 'Clients/Old.meeting'
    const title = '会議'.repeat(55)
    rig.writes.set(
      `${path}/transcript.local.md`,
      `# ${title}\n\nNot recorded yet: open this meeting and press Record.\n`,
    )
    const { meetingId } = await rig.meetings.start({ title, path })
    expect((await rig.meetings.get(meetingId)).folder).toBe(path)
  })

  it('is refused in a folder whose transcript is someone’s own file', async () => {
    const rig = await engineRig()
    const path = 'Clients/Acme/Notes.meeting'
    rig.writes.set(`${path}/transcript.local.md`, 'my own notes\n')
    await expect(rig.meetings.start({ path })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(rig.writes.get(`${path}/transcript.local.md`)).toBe('my own notes\n')
    expect(rig.meetings.list()).toEqual([])
  })
})

/** Move every file under `from` to `to`, as the vault's rename or move does. */
function moveFolder(writes: Map<string, string>, from: string, to: string): void {
  for (const [rel, text] of [...writes]) {
    if (!rel.startsWith(`${from}/`)) continue
    writes.delete(rel)
    writes.set(`${to}${rel.slice(from.length)}`, text)
  }
}

describe('a meeting folder changed in the vault', () => {
  it('in a fresh clone, whose folder held only this machine’s files, is written again', async () => {
    const first = await engineRig()
    const { meetingId, meeting, send } = await started(first)
    await send(0)
    const transcript = `${meeting.folder}/transcript.local.md`
    await until(() => first.writes.get(transcript)?.includes('said 1') === true)
    await first.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    await first.meetings.dispose()

    // The vault cloned again: git kept none of the folder's local files.
    const again = await engineRig({ userData: first.userData })
    await again.meetings.follow()
    await vi.advanceTimersByTimeAsync(6000)
    await again.meetings.follow()
    await until(() => again.writes.get(transcript)?.includes('said 1') === true)
    expect(again.meetings.list().map((m) => m.id)).toEqual([meetingId])
  })

  it('in a fresh clone, set to share minutes it never had, is written again', async () => {
    const first = await engineRig({ profile: { shareMinutes: true } })
    const { meetingId, meeting } = await started(first)
    const transcript = `${meeting.folder}/transcript.local.md`
    await until(() => first.writes.get(transcript)?.startsWith('---\nmeeting:') === true)
    // Stopped before anything was said: no minutes, so nothing git keeps.
    await first.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    expect(meeting.minutes.trim()).toBe('')
    expect(first.writes.has(`${meeting.folder}/minutes.md`)).toBe(false)
    await first.meetings.dispose()

    const again = await engineRig({ userData: first.userData })
    await again.meetings.follow()
    await vi.advanceTimersByTimeAsync(6000)
    await again.meetings.follow()
    await until(() => again.writes.has(transcript))
    expect(again.meetings.list().map((m) => m.id)).toEqual([meetingId])
  })

  it('from an earlier session, deleted while Holi was closed, is deleted', async () => {
    const first = await engineRig()
    const { meetingId, meeting, send } = await started(first)
    await send(0)
    const folder = meeting.folder
    await until(
      () => first.writes.get(`${folder}/transcript.local.md`)?.includes('said 1') === true,
    )
    await first.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    await first.meetings.dispose()
    // Deleted with Holi closed: the same clone, without the folder.
    for (const rel of [...first.writes.keys()]) {
      if (rel.startsWith(`${folder}/`)) first.writes.delete(rel)
    }

    const again = await engineRig({ userData: first.userData, root: first.root })
    expect(again.meetings.list().map((m) => m.id)).toEqual([meetingId])
    await again.meetings.follow()
    await vi.advanceTimersByTimeAsync(6000)
    await again.meetings.follow()
    await until(() => again.meetings.list().length === 0)
    expect([...again.writes.keys()].filter((rel) => rel.startsWith(`${folder}/`))).toEqual([])
  })

  it('deleted now is deleted even when this clone could not be named', async () => {
    const rig = await engineRig({ failWrites: (rel) => rel === '.holi/meetings.local.json' })
    const { meeting, send } = await started(rig)
    await send(0)
    const folder = meeting.folder
    await until(() => rig.writes.get(`${folder}/transcript.local.md`)?.includes('said 1') === true)
    for (const rel of [...rig.writes.keys()])
      if (rel.startsWith(`${folder}/`)) rig.writes.delete(rel)
    await rig.meetings.follow()
    await vi.advanceTimersByTimeAsync(6000)
    await rig.meetings.follow()
    await until(() => rig.meetings.list().length === 0)
    expect([...rig.writes.keys()].filter((rel) => rel.startsWith(`${folder}/`))).toEqual([])
  })

  it('from an earlier session is deleted with its folder now', async () => {
    const first = await engineRig()
    const { meetingId, meeting, send } = await started(first)
    await send(0)
    const folder = meeting.folder
    await until(
      () => first.writes.get(`${folder}/transcript.local.md`)?.includes('said 1') === true,
    )
    await first.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    await first.meetings.dispose()

    const again = await engineRig({ userData: first.userData, root: first.root })
    await again.meetings.follow()
    for (const rel of [...again.writes.keys()]) {
      if (rel.startsWith(`${folder}/`)) again.writes.delete(rel)
    }
    await again.meetings.follow()
    await vi.advanceTimersByTimeAsync(6000)
    await again.meetings.follow()
    await until(() => again.meetings.list().length === 0)
  })

  it('from before the suffix follows its folder renamed in place, and no copy elsewhere', async () => {
    const rig = await engineRig()
    const { meetingId } = await rig.meetings.start({ title: 'Standup', path: 'Meetings/Standup' })
    const meeting = await rig.meetings.get(meetingId)
    const transcript = 'Meetings/Standup/transcript.local.md'
    await until(() => rig.writes.get(transcript)?.startsWith('---\nmeeting:') === true)
    await rig.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    // A copy dragged into notes/, then the folder itself renamed in place.
    rig.writes.set('notes/transcript.local.md', rig.writes.get(transcript)!)
    rig.writes.set('notes/minutes.local.md', '# my notes\n')
    moveFolder(rig.writes, 'Meetings/Standup', 'Meetings/Daily')
    await rig.meetings.follow()
    expect(meeting.folder).toBe('Meetings/Daily')
    expect(rig.writes.get('notes/minutes.local.md')).toBe('# my notes\n')
  })

  it('whose transcript alone is dragged into another folder stays where it is', async () => {
    const rig = await engineRig()
    const { meetingId, meeting, send } = await started(rig)
    const from = meeting.folder
    const transcript = `${from}/transcript.local.md`
    await send(0)
    await until(() => rig.writes.get(transcript)?.includes('said 1') === true)
    await rig.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    rig.writes.set(`${from}/minutes.md`, '# shared minutes\n')
    rig.writes.set('notes/minutes.md', '# my notes\n')
    rig.writes.set('notes/transcript.local.md', rig.writes.get(transcript)!)
    rig.writes.delete(transcript)

    await rig.meetings.follow()
    await vi.advanceTimersByTimeAsync(6000)
    await rig.meetings.follow()
    await until(() => rig.writes.get(transcript)?.includes('said 1') === true)
    expect(meeting.folder).toBe(from)
    expect(rig.writes.get(`${from}/minutes.md`)).toBe('# shared minutes\n')
    expect(rig.writes.get('notes/minutes.md')).toBe('# my notes\n')

    // Its folder deleted later is a delete, not a move into the copy's folder.
    for (const rel of [...rig.writes.keys()]) if (rel.startsWith(`${from}/`)) rig.writes.delete(rel)
    await rig.meetings.follow()
    await vi.advanceTimersByTimeAsync(6000)
    await rig.meetings.follow()
    await until(() => rig.meetings.list().length === 0)
    expect(rig.writes.get('notes/minutes.md')).toBe('# my notes\n')
  })

  it('renamed or moved takes its meeting with it, which writes there from then on', async () => {
    const rig = await engineRig()
    const { meetingId, meeting, send } = await started(rig)
    const from = meeting.folder
    await send(0)
    await until(() => rig.writes.get(`${from}/transcript.local.md`)?.includes('said 1') === true)
    expect(rig.writes.get(`${from}/transcript.local.md`)).toMatch(
      new RegExp(`^---\nmeeting: ${meetingId}\n---\n`),
    )

    const to = 'Clients/Acme/Renamed.meeting'
    moveFolder(rig.writes, from, to)
    await rig.meetings.follow()
    expect(meeting.folder).toBe(to)
    expect(meeting.minutesPath).toBe(`${to}/minutes.local.md`)
    expect(rig.meetings.list()[0]).toMatchObject({ id: meetingId, folder: to })

    await send(1)
    await until(() => rig.writes.get(`${to}/transcript.local.md`)?.includes('said 2') === true)
    expect([...rig.writes.keys()].filter((rel) => rel.startsWith(`${from}/`))).toEqual([])
  })

  it('deleted while it records stops the recording and deletes the meeting, never made again', async () => {
    const rig = await engineRig()
    const { meetingId, meeting, dir, send } = await started(rig)
    await send(0)
    await until(
      () => rig.writes.get(`${meeting.folder}/transcript.local.md`)?.includes('said 1') === true,
    )
    for (const rel of [...rig.writes.keys()]) rig.writes.delete(rel)

    await rig.meetings.follow()
    // Missing for a moment is a move under way, not a delete.
    expect(rig.meetings.list().map((m) => m.id)).toEqual([meetingId])
    await send(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(rig.writes.size).toBe(0)

    await until(() => rig.meetings.list().length === 0)
    expect(rig.emitted.filter(([name]) => name === 'meeting-removed').map(([, p]) => p)).toEqual([
      { meetingId },
    ])
    await until(async () => !(await present(dir)))
    await expect(send(2)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(rig.writes.size).toBe(0)
    // What this machine had of it is set aside, not erased, and not listed.
    const removed = join(rig.userData, 'meetings', '.removed')
    const [kept] = await readdir(removed)
    expect(kept).toMatch(new RegExp(`^${meetingId}-\\d+$`))
    expect(await present(join(removed, kept!, 'state.json'))).toBe(true)
    const again = await engineRig({ userData: rig.userData, root: rig.root })
    expect(again.meetings.list()).toEqual([])
  })

  it('set aside when its folder went is erased for good after 30 days', async () => {
    const rig = await engineRig()
    const removed = join(rig.userData, 'meetings', '.removed')
    const day = 24 * 60 * 60 * 1000
    const old = `0123456789ab-${Date.now() - 31 * day}`
    const recent = `0123456789ab-${Date.now() - 29 * day}`
    for (const name of [old, recent]) {
      await mkdir(join(removed, name), { recursive: true })
      await writeFile(join(removed, name, 'state.json'), '{}')
    }
    await engineRig({ userData: rig.userData, root: rig.root })
    expect(await readdir(removed)).toEqual([recent])
  })

  it('whose transcript alone went, as in a fresh clone, writes it again and loses nothing', async () => {
    const rig = await engineRig()
    const { meetingId, meeting, dir, send } = await started(rig)
    await send(0)
    const transcript = `${meeting.folder}/transcript.local.md`
    await until(() => rig.writes.get(transcript)?.includes('said 1') === true)
    await rig.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    rig.writes.set(`${meeting.folder}/minutes.md`, '# shared\n')
    rig.writes.delete(transcript)

    await rig.meetings.follow()
    await until(() => rig.writes.get(transcript)?.includes('said 1') === true)
    expect(rig.meetings.list().map((m) => m.id)).toEqual([meetingId])
    expect(await present(join(dir, 'state.json'))).toBe(true)
  })

  it('whose transcript someone replaced with their own file leaves that file alone', async () => {
    const rig = await engineRig()
    const { meetingId, meeting, dir } = await started(rig)
    const transcript = `${meeting.folder}/transcript.local.md`
    await until(() => rig.writes.get(transcript)?.startsWith('---\nmeeting:') === true)
    await rig.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    rig.writes.set(transcript, 'my own notes\n')

    await rig.meetings.follow()
    await vi.advanceTimersByTimeAsync(6000)
    await rig.meetings.follow()
    await settle()
    expect(rig.writes.get(transcript)).toBe('my own notes\n')
    expect(rig.meetings.list()).toEqual([expect.objectContaining({ id: meetingId, away: true })])
    expect(await present(join(dir, 'state.json'))).toBe(true)
  })

  it('moved while a write raced it leaves nothing behind at the old path', async () => {
    const rig = await engineRig()
    const { meeting, send } = await started(rig)
    const from = meeting.folder
    await send(0)
    await until(() => rig.writes.has(`${from}/minutes.local.md`))
    moveFolder(rig.writes, from, 'Moved.meeting')
    // What a write racing the move made again beside no transcript.
    rig.writes.set(`${from}/minutes.local.md`, 'stale\n')
    await rig.meetings.follow()
    expect(meeting.folder).toBe('Moved.meeting')
    expect(rig.removed.at(-1)).toEqual({
      rels: [`${from}/minutes.local.md`, `${from}/minutes.md`],
      folder: from,
    })
  })

  it('deleted while a Pi assistant writes its topics stops that run too', async () => {
    const rig = await engineRig({
      provider: async () => 'pi',
      launch: async () => ({ ok: true, sessionId: SCRIBE }),
    })
    const { meetingId, meeting, send } = await started(rig)
    await until(() => meeting.scribeSessionId === SCRIBE)
    await send(0)
    await until(
      () => rig.writes.get(`${meeting.folder}/transcript.local.md`)?.includes('said 1') === true,
    )
    for (const rel of [...rig.writes.keys()]) rig.writes.delete(rel)
    await rig.meetings.follow()
    await until(() => !rig.meetings.list().some((m) => m.id === meetingId))
    expect(rig.agent.stop).toHaveBeenCalledWith(SCRIBE)
  })

  it('is never another meeting’s by its old path', async () => {
    const rig = await engineRig()
    const first = await started(rig, 'Test')
    await first.send(0)
    const folder = first.meeting.folder
    await until(() => rig.writes.has(`${folder}/transcript.local.md`))
    await rig.meetings.stop(first.meetingId)
    await until(() => first.meeting.phase === 'done')

    // Moved away, and a new meeting folder made where it was.
    moveFolder(rig.writes, folder, 'Archive/Test.meeting')
    rig.writes.set(
      `${folder}/transcript.local.md`,
      '# Test\n\nNot recorded yet: open this meeting and press Record.\n',
    )
    await rig.meetings.follow()
    expect(rig.meetings.list().find((m) => m.id === first.meetingId)?.folder).toBe(
      'Archive/Test.meeting',
    )
    const second = await rig.meetings.start({ title: 'Test', path: folder })
    expect((await rig.meetings.get(second.meetingId)).folder).toBe(folder)
    // A folder that holds a meeting is refused, whoever's record names it.
    await expect(rig.meetings.start({ path: 'Archive/Test.meeting' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })
})

describe('a chunk the renderer gave up on', () => {
  it('is stitched past at once, so the lines after it are not held until the stop', async () => {
    const rig = await engineRig()
    const { meetingId, meeting, send } = await started(rig)
    await send(1)
    await until(() => meeting.chunks[0]?.state === 'done')
    // Chunk 0 never came: the transcript waits for it.
    expect(meeting.segments).toEqual([])
    await rig.meetings.lose({ meetingId, n: 0, start: 0, duration: 8 })
    expect(meeting.segments.map((s) => s.chunk)).toEqual([1])
    expect(meeting.chunks[0]).toMatchObject({ n: 0, state: 'failed', error: 'never reached Holi' })
    // It is not tried again at the stop: there is no audio to try.
    await rig.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done')
    expect(rig.service.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('going away while a meeting records', () => {
  it('waits for the stop, or for at most the time it was given', async () => {
    const rig = await engineRig()
    const { meetingId } = await started(rig)
    let drained = false
    void rig.meetings.drain(10_000).then(() => (drained = true))
    await vi.advanceTimersByTimeAsync(1000)
    expect(drained).toBe(false)
    await rig.meetings.stop(meetingId)
    await until(() => drained)

    const other = await started(rig, 'Second')
    let late = false
    void rig.meetings.drain(10_000).then(() => (late = true))
    await vi.advanceTimersByTimeAsync(10_000)
    await until(() => late)
    expect((await rig.meetings.get(other.meetingId)).phase).toBe('recording')
  })
})

describe('an older meeting', () => {
  it('is read from disk once, however many ask for it at once', async () => {
    const rig = await engineRig()
    const { meetingId } = await started(rig)
    await rig.meetings.stop(meetingId)
    await until(async () => (await rig.meetings.get(meetingId)).phase === 'done')
    await rig.meetings.dispose()
    const again = await engineRig({ userData: rig.userData, root: rig.root })
    const [a, b] = await Promise.all([again.meetings.get(meetingId), again.meetings.get(meetingId)])
    expect(a).toBe(b)
  })
})

describe('starting', () => {
  it('names an untitled meeting by the time it started', async () => {
    const rig = await engineRig()
    await mkdir(join(rig.userData, 'meetings'), { recursive: true })
    const { meetingId } = await rig.meetings.start({ profileId: 'default' })
    expect((await rig.meetings.get(meetingId)).title).toMatch(/^Meeting \d\d\.\d\d$/)
  })
})

describe('another speech service', () => {
  it('is asked for its model, at its address, without a key when there is none', async () => {
    const rig = await engineRig({
      apiKey: async () => null,
      service: async () => ({ url: 'http://localhost:8000/v1', model: 'whisper-large-v3' }),
      profile: { asrModel: 'syv-transcribe' },
    })
    const { meeting, send } = await started(rig)
    await send(0)
    await until(() => meeting.chunks[0]?.state === 'done')
    expect(meeting.blocked).toBeUndefined()
    const [url, init] = rig.service.fetch.mock.calls[0]!
    expect(url).toBe('http://localhost:8000/v1/audio/transcriptions')
    expect((init.body as FormData).get('model')).toBe('whisper-large-v3')
  })
})

describe('without a speech key that works', () => {
  /** A key that can be set and taken away while the engine runs. */
  function keyed(initial: string | null) {
    let key = initial
    return {
      apiKey: async () => key,
      set: (next: string | null) => {
        key = next
      },
    }
  }

  it('keeps the chunks queued, untried, until a key is set, then uploads them', async () => {
    const key = keyed(null)
    const rig = await engineRig({ apiKey: key.apiKey })
    const { send, meeting } = await started(rig)
    await send(0)
    await send(1)
    await until(() => meeting.blocked === 'no-key')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await settle()
    expect(rig.service.fetch).not.toHaveBeenCalled()
    expect(meeting.chunks.map((c) => [c.state, c.tries])).toEqual([
      ['queued', 0],
      ['queued', 0],
    ])

    key.set('hv_now_there_is_one')
    rig.meetings.wake()
    await until(() => meeting.segments.length === 2)
    expect(chunkStates(meeting)).toEqual(['done', 'done'])
    expect(meeting.blocked).toBeUndefined()
    expect(rig.service.fetch.mock.calls[0]![1].headers).toEqual({
      Authorization: 'Bearer hv_now_there_is_one',
    })
  })

  it('takes a 401 as a refused key, not tried again until the key changes', async () => {
    const key = keyed('hv_revoked_key_000000')
    let calls = 0
    const rig = await engineRig({
      apiKey: key.apiKey,
      fetch: async (_url, init) => {
        calls++
        const auth = (init.headers as Record<string, string>)['Authorization']
        return auth === 'Bearer hv_revoked_key_000000'
          ? new Response('{"error":"invalid api key"}', { status: 401 })
          : Response.json({ segments: [{ start: 0, end: 2, text: 'Hej' }] })
      },
    })
    const { send, meeting } = await started(rig)
    await send(0)
    await until(() => meeting.blocked === 'bad-key')
    // A chunk after it is not sent with the key refused.
    await send(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await settle()
    expect(calls).toBe(1)
    expect(chunkStates(meeting)).toEqual(['queued', 'queued'])
    expect(meeting.chunks[0]!.error).not.toContain('hv_revoked')

    key.set('hv_a_good_one_00000000')
    rig.meetings.wake()
    await until(() => meeting.segments.length === 2)
    expect(meeting.blocked).toBeUndefined()
  })

  it('a meeting stopped while blocked waits for its chunks, past the finishing cap', async () => {
    const key = keyed(null)
    const rig = await engineRig({ apiKey: key.apiKey })
    const { send, meeting, meetingId } = await started(rig)
    await send(0)
    await until(() => meeting.blocked === 'no-key')
    await rig.meetings.stop(meetingId)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await settle()
    expect(meeting.phase).toBe('finishing')
    expect(chunkStates(meeting)).toEqual(['queued'])

    key.set('hv_now_there_is_one')
    rig.meetings.wake()
    await until(() => meeting.phase === 'done')
    expect(meeting.segments.map((s) => s.text)).toEqual(['said 1'])
  })

  it('a meeting left over from before a restart waits for the key too', async () => {
    const first = await engineRig({ apiKey: async () => null })
    const { meetingId } = await started(first, 'Crashed')
    await first.meetings.chunk({ meetingId, n: 0, start: 0, duration: 8, audio: chunkWav(8) })
    await first.meetings.dispose()

    const key = keyed(null)
    const again = await engineRig({
      userData: first.userData,
      root: first.root,
      apiKey: key.apiKey,
    })
    const meeting = await again.meetings.get(meetingId)
    await until(() => meeting.blocked === 'no-key')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await settle()
    expect(meeting.phase).toBe('finishing')
    expect(chunkStates(meeting)).toEqual(['queued'])

    key.set('hv_now_there_is_one')
    again.meetings.wake()
    await until(() => meeting.phase === 'done')
    expect(meeting.segments).toHaveLength(1)
  })
})

describe('a meeting that ended failed for want of a key', () => {
  const LEGACY = "SYV_API_KEY is not set in the vault's .env.local"

  /** A meeting that ended as Holi left it before keys were its own: chunk 1
   *  (12 s, so the fake can tell it apart) failed for the key, the rest as
   *  `fail` says, the audio of every failed chunk still on disk. */
  async function endedWithoutKey(phase: 'failed' | 'done') {
    const first = await engineRig({
      fetch: async (_url, init) => {
        const file = (init.body as FormData).get('file') as Blob
        return phase === 'failed' || file.size > 300_000
          ? new Response('no', { status: 500 })
          : Response.json({ segments: [{ start: 0, end: 2, text: `ok ${file.size}` }] })
      },
    })
    const { meetingId, meeting, dir } = await started(first, 'Without key')
    for (const [n, seconds] of [
      [0, 8],
      [1, 12],
      [2, 8],
    ] as const) {
      await first.meetings.chunk({
        meetingId,
        n,
        start: n * 8,
        duration: seconds,
        audio: chunkWav(seconds),
      })
    }
    await until(() => meeting.chunks.filter((c) => c.state === 'failed').length > 0)
    await first.meetings.stop(meetingId)
    await until(() => meeting.phase === phase)
    await first.meetings.dispose()
    const path = join(dir, 'state.json')
    const state = JSON.parse(await readFile(path, 'utf8'))
    for (const c of state.meeting.chunks) if (c.state === 'failed') c.error = LEGACY
    await writeFile(path, JSON.stringify(state))
    return { first, meetingId, dir }
  }

  it('is transcribed again once a key is there, without a scribe, and its transcript written', async () => {
    const { first, meetingId, dir } = await endedWithoutKey('failed')
    const again = await engineRig({ userData: first.userData, root: first.root })
    const meeting = await again.meetings.get(meetingId)
    await until(() => meeting.phase === 'done')
    expect(chunkStates(meeting)).toEqual(['done', 'done', 'done'])
    expect(meeting.segments.map((s) => [s.i, s.chunk])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ])
    expect(again.agent.launch).not.toHaveBeenCalled()
    expect(again.agent.message).not.toHaveBeenCalled()
    await until(() => again.writes.has(`${meeting.folder}/transcript.local.md`))
    expect(again.writes.get(`${meeting.folder}/transcript.local.md`)).toContain('said 3')
    expect((await readdir(dir)).filter((f) => f.endsWith('.wav'))).toEqual([])
  })

  it('takes only the failed chunks into a done one, numbering their lines after the last', async () => {
    const { first, meetingId, dir } = await endedWithoutKey('done')
    const before = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      .meeting as MeetingState
    expect(before.segments.map((s) => s.chunk)).toEqual([0, 2])

    const again = await engineRig({ userData: first.userData, root: first.root })
    const meeting = await again.meetings.get(meetingId)
    await until(() => meeting.phase === 'done' && meeting.segments.length === 3)
    expect(meeting.segments.map((s) => [s.i, s.chunk])).toEqual([
      [0, 0],
      [1, 2],
      [2, 1],
    ])
  })

  it('waits, blocked rather than failed, while there is still no key', async () => {
    const { first, meetingId } = await endedWithoutKey('failed')
    let key: string | null = null
    const again = await engineRig({
      userData: first.userData,
      root: first.root,
      apiKey: async () => key,
    })
    const meeting = await again.meetings.get(meetingId)
    await until(() => meeting.blocked === 'no-key')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await settle()
    expect(meeting.phase).toBe('finishing')
    expect(again.service.fetch).not.toHaveBeenCalled()

    key = 'hv_now_there_is_one'
    again.meetings.wake()
    await until(() => meeting.phase === 'done')
    expect(meeting.segments).toHaveLength(3)
  })
})
