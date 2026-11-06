/**
 * The scribe session: how it is started, fed per group rather than per
 * minute (only while idle, and only once three minutes of new transcript
 * wait, or the person pressed Summarise now), told a person's note at once,
 * and given the final pass with the last lines at Stop. The agent is a fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityError } from '../../../main/capabilities/error'
import { firstMessage, groupsChangeMessage, tellMessage } from '../shared/scribe-prompt'
import { BATCH_TRANSCRIPT_S, groupsInAnswer, type LaunchArgs } from '../main/scribe'
import { chunkWav, engineRig, SCRIBE, settle, until } from './engine-helpers'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

/** A line a minute: chunk n starts at n·60 s, its line at n·60 + 0.5 to + 2.5. */
const MINUTE = 60

async function meetingRig(opts: Parameters<typeof engineRig>[0] = {}) {
  const rig = await engineRig({
    launch: async (_args: LaunchArgs) => ({ ok: true, sessionId: SCRIBE }),
    ...opts,
  })
  const { meetingId } = await rig.meetings.start({ title: 'Planning', profileId: 'default' })
  const meeting = await rig.meetings.get(meetingId)
  await until(() => meeting.scribeSessionId === SCRIBE)
  const scribe = rig.meetings.scribe
  const say = async (n: number) => {
    await rig.meetings.chunk({
      meetingId,
      n,
      start: n * MINUTE,
      duration: 8,
      audio: chunkWav(8),
    })
    await until(() => meeting.segments.some((s) => s.chunk === n))
  }
  const sessions = (state: string) => scribe.hearSessions([{ id: SCRIBE, state }])
  const sentTo = (session: string) =>
    rig.agent.message.mock.calls.filter(([s]) => s === session).map(([, text]) => text)
  return { ...rig, meetingId, meeting, scribe, say, sessions, sentTo }
}

describe('the scribe', () => {
  it('starts with its brief, its rules and the profile’s model and MCP config', async () => {
    const rig = await meetingRig({
      profile: { scribeModel: 'sonnet', mcpConfig: '/Users/me/mcp.json', focus: 'Exports' },
    })
    expect(rig.agent.launch).toHaveBeenCalledWith({
      name: 'Meeting · Planning',
      system: expect.stringContaining('Exports'),
      prompt: firstMessage(),
      allow: ['Bash(holi meeting:*)'],
      deny: [
        'Read',
        'Edit',
        'Write',
        'Glob',
        'Grep',
        'NotebookEdit',
        'Read(//**)',
        'Edit(//**)',
        'WebFetch',
        'WebSearch',
        'Agent',
        'Task',
        'Monitor',
      ],
      model: 'sonnet',
      mcpConfig: '/Users/me/mcp.json',
    })
    expect(rig.meeting.scribeState).toBe('starting')
    rig.sessions('working')
    expect(rig.meeting.scribeState).toBe('working')
    rig.scribe.hearSessions([])
    expect(rig.meeting.scribeState).toBe('gone')
  })

  it(`gets a batch only once ${BATCH_TRANSCRIPT_S} s of new transcript wait, never mid-turn`, async () => {
    const rig = await meetingRig()
    rig.sessions('idle')
    for (const n of [0, 1, 2]) await rig.say(n)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // Two minutes of transcript, and plenty of wall time: still nothing.
    expect(rig.sentTo(SCRIBE)).toEqual([])
    await rig.say(3)
    await until(() => rig.sentTo(SCRIBE).length === 1)
    const first = rig.sentTo(SCRIBE)[0]!
    for (const n of [0, 1, 2, 3]) expect(first).toContain(`[${n}] Me (${n}:00)`)
    // The groups so far: the first, open, as the first line made it.
    expect(first).toContain('Groups so far:\n[0] (untitled) (0:00–now, open)')
    expect(rig.meeting.scribeCursor).toBe(3)
    expect(rig.meeting.scribeState).toBe('working')

    // While its turn runs, three more minutes wait.
    for (const n of [4, 5, 6]) await rig.say(n)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.sentTo(SCRIBE)).toHaveLength(1)
    rig.scribe.hearTurnEnd(SCRIBE)
    await until(() => rig.sentTo(SCRIBE).length === 2)
    const second = rig.sentTo(SCRIBE)[1]!
    expect(second).toContain('[4] Me (4:00)')
    expect(second).toContain('[6] Me (6:00)')
    expect(second).not.toContain('[3] Me')
    expect(rig.meeting.scribeCursor).toBe(6)
  })

  it('gets the next batch at once when the person presses Summarise now', async () => {
    const rig = await meetingRig()
    rig.sessions('idle')
    await rig.say(0)
    expect(rig.sentTo(SCRIBE)).toEqual([])
    await rig.meetings.summarise(rig.meetingId)
    await until(() => rig.sentTo(SCRIBE).length === 1)
    expect(rig.sentTo(SCRIBE)[0]).toContain('[0] Me (0:00)')
    expect(rig.sentTo(SCRIBE)[0]).toContain('Summarise now')

    // Pressed mid-turn, it waits for the turn to end, then goes with nothing new.
    await rig.meetings.summarise(rig.meetingId)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(rig.sentTo(SCRIBE)).toHaveLength(1)
    rig.scribe.hearTurnEnd(SCRIBE)
    await until(() => rig.sentTo(SCRIBE).length === 2)
    expect(rig.sentTo(SCRIBE)[1]).toContain('No new transcript')
    expect(rig.sentTo(SCRIBE)[1]).toContain('Summarise now')

    // Once delivered, the next batch waits for transcript again.
    rig.scribe.hearTurnEnd(SCRIBE)
    await rig.say(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(rig.sentTo(SCRIBE)).toHaveLength(2)
  })

  it('cannot be asked to summarise without a scribe', async () => {
    const rig = await meetingRig()
    rig.scribe.hearSessions([])
    await expect(rig.meetings.summarise(rig.meetingId)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })

  it('is tried again while it cannot take messages yet', async () => {
    let refusals = 2
    const rig = await meetingRig({
      message: async () => {
        if (refusals-- > 0) throw new CapabilityError('UNAVAILABLE', 'not said where yet')
        return { ok: true }
      },
    })
    rig.sessions('idle')
    for (const n of [0, 1, 2, 3]) await rig.say(n)
    await until(() => rig.meeting.scribeCursor === 3)
    expect(rig.agent.message).toHaveBeenCalledTimes(3)
  })

  it('gives up after about half a minute, and the lines wait for the next try', async () => {
    const rig = await meetingRig({
      message: async () => {
        throw new CapabilityError('UNAVAILABLE', 'not said where yet')
      },
    })
    rig.sessions('idle')
    for (const n of [0, 1, 2, 3]) await rig.say(n)
    await until(() => rig.agent.message.mock.calls.length === 6)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(rig.agent.message).toHaveBeenCalledTimes(6)
    expect(rig.meeting.scribeCursor).toBe(-1)
  })

  it('that never takes a batch is marked unreachable, tried slowly, and catches up', async () => {
    let reachable = false
    const rig = await meetingRig({
      message: async () => {
        if (!reachable) {
          throw new CapabilityError('UNAVAILABLE', 'has not said where it takes messages')
        }
        return { ok: true }
      },
    })
    rig.sessions('idle')
    for (const n of [0, 1, 2, 3]) await rig.say(n)
    await until(() => rig.meeting.scribeUnreachable === true)
    expect(rig.agent.message).toHaveBeenCalledTimes(6)
    // Slowly, in the background: one try a minute.
    await vi.advanceTimersByTimeAsync(59_000)
    expect(rig.agent.message).toHaveBeenCalledTimes(6)
    await until(() => rig.agent.message.mock.calls.length === 7)
    await vi.advanceTimersByTimeAsync(5000)
    expect(rig.agent.message).toHaveBeenCalledTimes(7)
    await rig.say(4)

    reachable = true
    await until(() => rig.meeting.scribeCursor === 4)
    expect(rig.meeting.scribeUnreachable).toBeUndefined()
    const caughtUp = rig.sentTo(SCRIBE).at(-1)!
    expect(caughtUp).toContain('[0] Me')
    expect(caughtUp).toContain('[4] Me')
  })

  it('hears a person’s note at once, even mid-turn', async () => {
    const rig = await meetingRig()
    rig.sessions('working')
    await rig.meetings.tell(rig.meetingId, 'Focus on the export.')
    await rig.meetings.tell(rig.meetingId, 'Drop the budget talk', 'minutes')
    expect(rig.sentTo(SCRIBE)).toEqual([
      tellMessage('Focus on the export.'),
      groupsChangeMessage('Drop the budget talk'),
    ])
  })

  it('cannot be told anything once it is gone', async () => {
    const rig = await meetingRig()
    rig.scribe.hearSessions([])
    await expect(rig.meetings.tell(rig.meetingId, 'hello')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })
})

describe('the end of a meeting', () => {
  it('sends the last lines with the final pass once idle, the last group shown closed', async () => {
    const rig = await meetingRig()
    rig.sessions('working')
    await rig.say(0)
    await rig.meetings.stop(rig.meetingId)
    await vi.advanceTimersByTimeAsync(5000)
    expect(rig.meeting.phase).toBe('finishing')
    expect(rig.sentTo(SCRIBE)).toEqual([])
    rig.scribe.hearTurnEnd(SCRIBE)
    await until(() => rig.sentTo(SCRIBE).length === 1)
    const final = rig.sentTo(SCRIBE)[0]!
    expect(final).toContain('[0] Me (0:00)')
    expect(final).toContain('The meeting has ended')
    // Shown closed, and not written yet: the final pass writes it in full.
    expect(final).toMatch(/\[0\] \(untitled\) \(0:00–0:02\) — not written yet/)
    expect(final).not.toContain('open)')
    // While the pass runs the group is still open, so the pass may cut it.
    expect(rig.meeting.topics[0]!.open).toBe(true)
    // A stale idle before its turn starts is not the end of it.
    rig.sessions('idle')
    await vi.advanceTimersByTimeAsync(1000)
    expect(rig.meeting.phase).toBe('finishing')
    rig.sessions('working')
    rig.scribe.hearTurnEnd(SCRIBE)
    await until(() => rig.meeting.phase === 'done')
    // Closed with the meeting, and stale since nothing wrote it.
    expect(rig.meeting.topics[0]).toMatchObject({ open: false, stale: true })
  })

  it('is done after three minutes when the scribe never comes back', async () => {
    const rig = await meetingRig()
    rig.sessions('working')
    await rig.meetings.stop(rig.meetingId)
    const stoppedAt = Date.now()
    await until(() => rig.meeting.phase === 'done', 200_000)
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(3 * 60_000)
    expect(rig.sentTo(SCRIBE)).toEqual([])
  })

  it('gets its whole three minutes from when the last upload is done', async () => {
    // Transcription that takes four minutes, longer than the final pass's time.
    const slow = () =>
      new Promise<Response>((resolve) =>
        setTimeout(
          () => resolve(Response.json({ segments: [{ start: 0.5, end: 2.5, text: 'late' }] })),
          4 * 60_000,
        ),
      )
    const rig = await meetingRig({ fetch: slow })
    rig.sessions('idle')
    await rig.meetings.chunk({
      meetingId: rig.meetingId,
      n: 0,
      start: 0,
      duration: 8,
      audio: chunkWav(8),
    })
    await rig.meetings.stop(rig.meetingId)
    await until(() => rig.meeting.segments.length === 1, 300_000)
    // Past the three minutes from the stop, yet the pass is still to come.
    await until(() => rig.sentTo(SCRIBE).length === 1)
    expect(rig.meeting.phase).toBe('finishing')
    rig.sessions('working')
    rig.scribe.hearTurnEnd(SCRIBE)
    await until(() => rig.meeting.phase === 'done')
  })

  it('waits for a scribe still starting, then gives it the final pass', async () => {
    let started: (() => void) | undefined
    const rig = await engineRig({
      launch: () =>
        new Promise((resolve) => {
          started = () => resolve({ ok: true, sessionId: SCRIBE })
        }),
    })
    const { meetingId } = await rig.meetings.start({ title: 'Quick', profileId: 'default' })
    const meeting = await rig.meetings.get(meetingId)
    await rig.meetings.chunk({ meetingId, n: 0, start: 0, duration: 8, audio: chunkWav(8) })
    await rig.meetings.stop(meetingId)
    await vi.advanceTimersByTimeAsync(5000)
    expect(meeting.scribeState).toBe('starting')
    started!()
    await until(() => meeting.scribeSessionId === SCRIBE)
    rig.meetings.scribe.hearSessions([{ id: SCRIBE, state: 'idle' }])
    await until(() =>
      rig.agent.message.mock.calls.some(([, text]) => text.includes('The meeting has ended')),
    )
    expect(meeting.phase).toBe('finishing')
  })

  it('on Pi is a run with no tools that answers with its groups, which main writes', async () => {
    let answer: string | null = '[]'
    const rig = await meetingRig({
      provider: async () => 'pi',
      reply: async () => answer,
      profile: { scribeModel: 'sonnet', mcpConfig: '/Users/me/mcp.json' },
    })
    // No rules to keep it in: it has nothing to break them with. Claude
    // Code's model and MCP servers are not Pi's.
    expect(rig.agent.launch).toHaveBeenCalledWith({
      name: 'Meeting · Planning',
      provider: 'pi',
      tools: 'none',
      keep: true,
      system: expect.stringContaining('one JSON array per answer'),
      prompt: firstMessage('reply'),
    })
    const system = rig.agent.launch.mock.calls[0]![0].system!
    expect(system).not.toContain('holi meeting group')
    expect(rig.meeting.scribeUnsupported).toBeUndefined()

    rig.scribe.hearTurnEnd(SCRIBE)
    await rig.say(0)
    await rig.meetings.stop(rig.meetingId)
    await until(() => rig.sentTo(SCRIBE).some((t) => t.includes('The meeting has ended')))
    expect(rig.sentTo(SCRIBE).at(-1)).toMatch(/Answer with the JSON array only\.$/)
    // Idle alone is not the end of its turn: its answer is.
    rig.sessions('idle')
    expect(rig.meeting.phase).toBe('finishing')
    answer =
      'Here:\n```json\n[{"startIndex":0,"title":"Exports","keywords":["csv","export"],"summary":["CSV export is wanted."]}]\n```'
    rig.scribe.hearTurnEnd(SCRIBE)
    await until(() => rig.meeting.phase === 'done')
    expect(rig.meeting.topics[0]).toMatchObject({ title: 'Exports', keywords: ['csv', 'export'] })
    expect(rig.agent.stop).toHaveBeenCalledWith(SCRIBE)
  })

  it('on Pi is stopped when the plugin shuts down with the meeting still recording', async () => {
    const rig = await meetingRig({ provider: async () => 'pi', reply: async () => '[]' })
    expect(rig.meeting.phase).toBe('recording')
    await rig.meetings.dispose()
    expect(rig.agent.stop).toHaveBeenCalledWith(SCRIBE)
  })

  it('started for a meeting deleted meanwhile is stopped, not left running', async () => {
    let started: ((v: { ok: true; sessionId: string }) => void) | undefined
    const rig = await engineRig({
      provider: async () => 'pi',
      launch: () => new Promise((r) => (started = r)),
    })
    const { meetingId } = await rig.meetings.start({ title: 'Gone', profileId: 'default' })
    const meeting = await rig.meetings.get(meetingId)
    await until(() => started !== undefined)
    await until(() => rig.writes.has(`${meeting.folder}/transcript.local.md`))
    // Its folder is deleted from the vault while the run starts.
    for (const rel of [...rig.writes.keys()]) rig.writes.delete(rel)
    await rig.meetings.follow()
    await vi.advanceTimersByTimeAsync(6000)
    await rig.meetings.follow()
    await until(() => rig.meetings.list().length === 0)
    started!({ ok: true, sessionId: SCRIBE })
    await until(() => rig.agent.stop.mock.calls.length > 0)
    expect(rig.agent.stop).toHaveBeenCalledWith(SCRIBE)
    expect(meeting.scribeSessionId).toBeUndefined()
  })

  it('started after the meeting finished without it is stopped, not kept running', async () => {
    let started: ((v: { ok: true; sessionId: string }) => void) | undefined
    const rig = await engineRig({
      provider: async () => 'pi',
      launch: () => new Promise((r) => (started = r)),
    })
    const { meetingId } = await rig.meetings.start({ title: 'Slow', profileId: 'default' })
    const meeting = await rig.meetings.get(meetingId)
    await until(() => started !== undefined)
    await rig.meetings.stop(meetingId)
    await vi.advanceTimersByTimeAsync(61_000)
    await until(() => meeting.phase === 'done')
    started!({ ok: true, sessionId: SCRIBE })
    await until(() => rig.agent.stop.mock.calls.length > 0)
    expect(rig.agent.stop).toHaveBeenCalledWith(SCRIBE)
    expect(meeting.scribeSessionId).toBeUndefined()
  })

  it('is not started when the plugin stopped while it looked up the agent', async () => {
    let chosen: ((p: 'pi') => void) | undefined
    const rig = await engineRig({
      provider: () => new Promise((r) => (chosen = r)),
      launch: async () => ({ ok: true, sessionId: SCRIBE }),
    })
    await rig.meetings.start({ title: 'Closing', profileId: 'default' })
    await until(() => chosen !== undefined)
    await rig.meetings.dispose()
    chosen!('pi')
    await settle()
    expect(rig.agent.launch).not.toHaveBeenCalled()
  })

  it('is not started on an agent that cannot run it, and the meeting says why', async () => {
    const rig = await engineRig({
      launch: async () => ({ ok: true, sessionId: SCRIBE }),
      provider: async () => 'codex',
    })
    const { meetingId } = await rig.meetings.start({ title: 'Solo', profileId: 'default' })
    const meeting = await rig.meetings.get(meetingId)
    await until(() => meeting.scribeState === 'off')
    expect(meeting.scribeUnsupported).toBe('codex')
    expect(rig.agent.launch).not.toHaveBeenCalled()
    await rig.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done', 5000)
  })

  it('is done at once without a scribe', async () => {
    const rig = await engineRig()
    const { meetingId } = await rig.meetings.start({ title: 'Solo', profileId: 'default' })
    const meeting = await rig.meetings.get(meetingId)
    await until(() => meeting.scribeState === 'gone')
    await rig.meetings.stop(meetingId)
    await until(() => meeting.phase === 'done', 5000)
  })
})

describe('a person’s word to a Pi assistant', () => {
  it('waits for the turn under way, so its answer is not run into the next', async () => {
    const rig = await meetingRig({ provider: async () => 'pi', reply: async () => '[]' })
    rig.scribe.hearTurnEnd(SCRIBE)
    await until(() => rig.meeting.scribeState === 'idle')
    // A batch is out: the run is working.
    rig.scribe.summarise(rig.meetingId)
    await until(() => rig.meeting.scribeState === 'working')
    const before = rig.sentTo(SCRIBE).length
    let told = false
    void rig.scribe.tell(rig.meetingId, 'drop the budget talk', 'minutes').then(() => (told = true))
    await vi.advanceTimersByTimeAsync(1000)
    expect(rig.sentTo(SCRIBE)).toHaveLength(before)
    rig.scribe.hearTurnEnd(SCRIBE)
    await until(() => told)
    expect(rig.sentTo(SCRIBE).at(-1)).toContain('drop the budget talk')
    expect(rig.meeting.scribeState).toBe('working')
  })

  it('is told it was not taken when the run ends before its turn does', async () => {
    const rig = await meetingRig({ provider: async () => 'pi', reply: async () => '[]' })
    rig.scribe.hearTurnEnd(SCRIBE)
    await until(() => rig.meeting.scribeState === 'idle')
    rig.scribe.summarise(rig.meetingId)
    await until(() => rig.meeting.scribeState === 'working')
    let outcome: 'pending' | 'taken' | 'refused' = 'pending'
    void rig.scribe.tell(rig.meetingId, 'drop the budget talk').then(
      () => (outcome = 'taken'),
      () => (outcome = 'refused'),
    )
    await vi.advanceTimersByTimeAsync(10)
    // Its run is no longer listed.
    rig.scribe.hearSessions([])
    await until(() => outcome !== 'pending')
    expect(outcome).toBe('refused')
    expect(rig.sentTo(SCRIBE).some((t) => t.includes('drop the budget talk'))).toBe(false)
  })
})

describe('a person’s word to a Pi assistant, at the edges', () => {
  /** What became of a note: still waiting, taken, or refused. */
  const watch = (p: Promise<void>) => {
    const o = { now: 'pending' as 'pending' | 'taken' | 'refused' }
    void p.then(
      () => (o.now = 'taken'),
      () => (o.now = 'refused'),
    )
    return o
  }

  it('waits for the first turn, which is running from the moment it starts', async () => {
    let answer: string | null = null
    const rig = await meetingRig({ provider: async () => 'pi', reply: async () => answer })
    expect(rig.meeting.scribeState).toBe('working')
    const before = rig.sentTo(SCRIBE).length
    const note = watch(rig.scribe.tell(rig.meetingId, 'drop the budget talk'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(rig.sentTo(SCRIBE)).toHaveLength(before)
    answer = '[]'
    rig.scribe.hearTurnEnd(SCRIBE)
    await until(() => note.now !== 'pending')
    expect(note.now).toBe('taken')
    expect(rig.sentTo(SCRIBE).at(-1)).toContain('drop the budget talk')
  })

  it('goes once a batch that never reached the run is given up', async () => {
    let fail: ((err: Error) => void) | null = null
    const rig = await meetingRig({
      provider: async () => 'pi',
      reply: async () => '[]',
      message: (_s, text) =>
        text.includes('drop the budget talk')
          ? Promise.resolve({ ok: true })
          : new Promise((_, reject) => (fail = reject)),
    })
    await until(() => rig.meeting.scribeState === 'idle')
    rig.scribe.summarise(rig.meetingId)
    await until(() => fail !== null)
    const note = watch(rig.scribe.tell(rig.meetingId, 'drop the budget talk'))
    await vi.advanceTimersByTimeAsync(10)
    expect(note.now).toBe('pending')
    fail!(new Error('the run is not there'))
    await until(() => note.now !== 'pending')
    expect(note.now).toBe('taken')
    expect(rig.sentTo(SCRIBE).at(-1)).toContain('drop the budget talk')
  })

  it('is refused when the meeting ends before the turn under way does', async () => {
    const rig = await meetingRig({ provider: async () => 'pi', reply: async () => '[]' })
    await until(() => rig.meeting.scribeState === 'idle')
    await rig.say(0)
    rig.scribe.summarise(rig.meetingId)
    await until(() => rig.meeting.scribeState === 'working')
    await rig.meetings.stop(rig.meetingId)
    const note = watch(rig.scribe.tell(rig.meetingId, 'drop the budget talk'))
    // No turn ever ends: the final pass runs out of time.
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    await until(() => rig.meeting.phase === 'done')
    await until(() => note.now !== 'pending')
    expect(note.now).toBe('refused')
    await expect(rig.scribe.tell(rig.meetingId, 'too late')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })
})

describe('a tool-less scribe’s answer', () => {
  it('is its JSON array, fenced or not; anything else holds no groups', () => {
    expect(groupsInAnswer('[{"startIndex":0}]')).toEqual([{ startIndex: 0 }])
    expect(groupsInAnswer('```json\n[]\n```')).toEqual([])
    expect(groupsInAnswer('ok')).toBeNull()
    expect(groupsInAnswer('[not json')).toBeNull()
    expect(groupsInAnswer('{"startIndex":0}')).toBeNull()
    // Two answers run together: both count, brackets inside text do not.
    expect(groupsInAnswer('[{"title":"a [b]"}]\n[{"startIndex":2}]')).toEqual([
      { title: 'a [b]' },
      { startIndex: 2 },
    ])
    expect(groupsInAnswer(null)).toBeNull()
  })
})
