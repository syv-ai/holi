/**
 * What a person changes after the fact: a transcript line's words, a
 * group's fields, the groups by asking the scribe, a task made from lines of
 * the meeting, and how a task is sent; and how each reaches the scribe. Through the real registry and the real
 * engine over temporary folders; the agent, the Holis and the speech service
 * are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveArgv } from '../../../main/bridge/cli'
import { CapabilityError } from '../../../main/capabilities/error'
import {
  createCapabilityRegistry,
  type CapabilityContext,
} from '../../../main/capabilities/registry'
import type { Card, MeetingState, Segment } from '../shared/meeting'
import { cardSpec, MAX_RANGE_TEXT } from '../main/build'
import { MAX_TASK_LINES, taskCard } from '../main/cards'
import { meetingCapabilities, MEETING_NAMESPACES } from '../main/capabilities'
import type { Profiles } from '../main/profiles'
import { chunkWav, engineRig, SCRIBE, until } from './engine-helpers'

const BUILD = 'b0b0b0b0'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

async function rig(opts: Parameters<typeof engineRig>[0] = {}) {
  const engine = await engineRig({
    launch: async (args) => ({
      ok: true,
      sessionId: args.name.includes(' · ') && !args.name.startsWith('Meeting') ? BUILD : SCRIBE,
    }),
    ...opts,
  })
  const profiles: Profiles = {
    list: async () => [engine.profile],
    get: async () => engine.profile,
    save: async (p) => p,
    delete: async () => {},
  }
  const registry = createCapabilityRegistry()
  registry.register(
    MEETING_NAMESPACES,
    meetingCapabilities({
      meetings: engine.meetings,
      profiles,
      speechKey: {} as never,
      services: { get: async () => ({ url: null, model: null }), set: async (s) => s },
      serviceChanged: () => {},
      remote: 'syv/vault',
    }),
  )
  const ctx = { remote: 'syv/vault', root: engine.root, bundle: null } as CapabilityContext
  const ui = (name: string, params: unknown = {}) => registry.run(name, 'ui', ctx, params)
  const holi = async (argv: string[], stdin: string | null) => {
    const request = resolveArgv(['meeting', ...argv], registry.commands(), stdin, SCRIBE)
    if (request.kind !== 'run') throw new Error(`not a run: ${JSON.stringify(request)}`)
    return registry.run(request.name, 'cli', ctx, request.params)
  }
  const { value } = await ui('meeting.start', { title: 'Planning', profileId: 'default' })
  const meetingId = (value as { meetingId: string }).meetingId
  const meeting = (await ui('meeting.get', { meetingId })).value as MeetingState
  // Started, or, on an agent that cannot run it, not.
  await until(() => meeting.scribeSessionId === SCRIBE || meeting.scribeUnsupported !== undefined)
  const say = async (n: number) => {
    await ui('meeting.chunk', {
      meetingId,
      n,
      start: n * 8,
      duration: 8,
      audio: Buffer.from(chunkWav(8, n % 2 === 0 ? 'me' : 'them')).toString('base64'),
    })
    await until(() => meeting.segments.some((s) => s.chunk === n))
  }
  const sentTo = (session: string) =>
    engine.agent.message.mock.calls.filter(([s]) => s === session).map(([, text]) => text)
  const scribe = engine.meetings.scribe
  const idle = () => scribe.hearSessions([{ id: SCRIBE, state: 'idle' }])
  /** A task a person makes from lines of the meeting. */
  const card = async (over: Record<string, unknown> = {}) =>
    (
      await ui('meeting.task.create', {
        meetingId,
        lines: [1, 0],
        prompt: 'Export to CSV',
        kind: 'feature',
        ...over,
      })
    ).value as Card
  /** The scribe's next batch, now: it is idle and the person presses
   *  Summarise now. */
  const batch = async () => {
    const before = sentTo(SCRIBE).length
    idle()
    await ui('meeting.summarise', { meetingId })
    await until(() => sentTo(SCRIBE).length === before + 1)
    scribe.hearSessions([{ id: SCRIBE, state: 'working' }])
    return sentTo(SCRIBE).at(-1)!
  }
  return { ...engine, ui, holi, meetingId, meeting, say, sentTo, scribe, idle, card, batch }
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a refusal')
    },
    (err: unknown) => {
      if (!(err instanceof CapabilityError)) throw err
      return { code: err.code, message: err.message }
    },
  )

describe('a corrected transcript line', () => {
  it('reads as corrected, on the line, on every task quoting it and in the transcript file', async () => {
    const r = await rig()
    await r.say(0)
    await r.say(1)
    const c = await r.card()
    const { value } = await r.ui('meeting.segment.edit', {
      meetingId: r.meetingId,
      i: 1,
      text: '  Export the board to CSV  ',
    })
    expect(value).toMatchObject({ i: 1, text: 'Export the board to CSV', edited: true })
    const seg = r.meeting.segments[1] as Segment
    expect(seg).toMatchObject({ text: 'Export the board to CSV', edited: true })
    const quoted = r.meeting.cards.find((x) => x.id === c.id)!
    expect(quoted.quotes.map((q) => q.text)).toEqual([
      r.meeting.segments[0]!.text,
      'Export the board to CSV',
    ])
    const transcript = [...r.writes.entries()].find(([k]) => k.endsWith('transcript.local.md'))
    expect(transcript?.[1]).toContain('Export the board to CSV')
    await until(() =>
      r.emitted.some(
        ([name, m]) =>
          name === 'meeting' && (m as MeetingState).segments[1]?.text === 'Export the board to CSV',
      ),
    )
  })

  it('is refused empty, too long, or for a line the meeting does not have', async () => {
    const r = await rig()
    await r.say(0)
    const edit = (i: unknown, text: unknown) =>
      refusal(r.ui('meeting.segment.edit', { meetingId: r.meetingId, i, text }))
    expect(await edit(0, '   ')).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await edit(0, 'x'.repeat(2001))).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await edit(-1, 'hi')).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await edit(7, 'hi')).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reaches the scribe once, in its next batch, as the person’s correction', async () => {
    const r = await rig()
    await r.say(0)
    expect(await r.batch()).toContain('[0] Me (0:00)')
    await r.ui('meeting.segment.edit', { meetingId: r.meetingId, i: 0, text: 'Ship it on Friday' })
    await r.say(1)
    // Nothing goes into a working turn.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.sentTo(SCRIBE)).toHaveLength(1)
    const next = await r.batch()
    expect(next).toContain('[1] Them (0:08)')
    expect(next).toContain('Corrections from the person')
    expect(next).toContain('[0] now reads: Ship it on Friday')
    await r.say(2)
    expect(await r.batch()).not.toContain('Corrections from the person')
  })

  it('that the scribe has not been sent yet goes in its batch as corrected, with no correction', async () => {
    const r = await rig()
    await r.say(0)
    await r.ui('meeting.segment.edit', { meetingId: r.meetingId, i: 0, text: 'Ship it on Friday' })
    const first = await r.batch()
    expect(first).toContain('[0] Me (0:00): Ship it on Friday')
    expect(first).not.toContain('Corrections from the person')
  })
})

describe('a correction while a batch is on its way', () => {
  it('reaches the scribe with the next batch, though the batch carried the old words', async () => {
    let deliver: (() => void) | undefined
    let holding = true
    const r = await rig({
      message: (_s, _t) =>
        holding
          ? new Promise((resolve) => {
              deliver = () => resolve({ ok: true })
            })
          : Promise.resolve({ ok: true }),
    })
    await r.say(0)
    r.idle()
    await r.ui('meeting.summarise', { meetingId: r.meetingId })
    await until(() => deliver !== undefined)
    // The batch with line 0 is on its way; the person corrects line 0.
    await r.ui('meeting.segment.edit', { meetingId: r.meetingId, i: 0, text: 'corrected words' })
    holding = false
    deliver!()
    await until(() => r.meeting.scribeCursor === 0)
    r.scribe.hearSessions([{ id: SCRIBE, state: 'working' }])
    expect(await r.batch()).toContain('[0] now reads: corrected words')
  })
})

describe('a group a person edits', () => {
  it('is in the minutes and the file at once, and reaches the scribe with its next batch', async () => {
    const r = await rig()
    await r.say(0)
    await r.batch()
    await r.ui('meeting.group.edit', {
      meetingId: r.meetingId,
      groupId: 't0',
      patch: { title: 'CSV for finance', decisions: ['CSV first'] },
    })
    expect(r.meeting.minutes).toContain('### Nu: CSV for finance')
    expect(r.meeting.minutes).toContain('- CSV first (CSV for finance)')
    expect([...r.writes.entries()].find(([k]) => k.endsWith('minutes.local.md'))?.[1]).toBe(
      r.meeting.minutes,
    )
    // It rides the next batch, with what the fields say now, and only once.
    const next = await r.batch()
    expect(next).toContain('The person edited these groups')
    expect(next).toContain('[0] {"title":"CSV for finance","decisions":["CSV first"]}')
    expect(next).toContain('the person’s: title, decisions')
    expect(await r.batch()).not.toContain('The person edited these groups')
  })

  it('of a meeting that is over is kept, with no scribe to tell', async () => {
    const r = await rig()
    await r.say(0)
    await r.ui('meeting.stop', { meetingId: r.meetingId })
    r.scribe.hearSessions([])
    await until(() => r.meeting.phase === 'done')
    await r.ui('meeting.group.edit', {
      meetingId: r.meetingId,
      groupId: 't0',
      patch: { title: 'Final', summary: ['Done'] },
    })
    expect(r.meeting.minutes).toContain('### Final (0:00–0:02)\n\n- Done')
    expect(r.sentTo(SCRIBE)).toEqual([])
  })
})

describe('a split or merge', () => {
  it('lists the groups it touched as not written, for the scribe to write again', async () => {
    const r = await rig()
    for (const n of [0, 1, 2]) await r.say(n)
    await r.batch()
    await r.ui('meeting.group.split', { meetingId: r.meetingId, i: 1 })
    await r.ui('meeting.group.split', { meetingId: r.meetingId, i: 2 })
    const next = await r.batch()
    expect(next).toMatch(/\[0\] \(untitled\) \(0:00–0:02\) — not written yet/)
    expect(next).toMatch(/\[1\] \(untitled\) \(0:08–0:10\) — not written yet/)
    expect(next).toContain('[2] (untitled) (0:16–now, open)')
  })
})

describe('sending a task', () => {
  it('to Claude puts how the person wants it done in the brief and the task', async () => {
    const r = await rig()
    await r.say(0)
    await r.say(1)
    const c = await r.card()
    const { value } = await r.ui('meeting.build', {
      meetingId: r.meetingId,
      cardId: c.id,
      context: 'Use the existing export menu; no new dependencies.',
      target: { kind: 'agent' },
    })
    expect(value).toEqual({ sessionId: BUILD })
    const args = r.agent.launch.mock.calls.at(-1)![0]
    expect(args.name).toBe('Build · Export to CSV')
    expect(args.prompt).toContain('How the person wants it done')
    expect(args.prompt).toContain('Use the existing export menu; no new dependencies.')
    // One stretch, under its times.
    expect(args.prompt).toContain('## What was said from 0:00 to 0:10')
    const task = r.agent.createTask.mock.calls[0]![0] as { description: string }
    expect(task.description).toContain('Use the existing export menu; no new dependencies.')
    expect(r.meeting.cards[0]).toMatchObject({
      status: 'building',
      buildSessionId: BUILD,
      target: { kind: 'agent' },
    })
  })

  it('refreshes a task made earlier with the card as it is now', async () => {
    const r = await rig()
    await r.say(0)
    await r.say(1)
    const c = await r.card()
    await r.ui('meeting.card', {
      meetingId: r.meetingId,
      cardId: c.id,
      patch: { status: 'accepted' },
    })
    expect(r.agent.createTask).toHaveBeenCalledTimes(1)
    await r.ui('meeting.card', {
      meetingId: r.meetingId,
      cardId: c.id,
      patch: { title: 'Export the board', acceptance: ['Columns match'] },
    })
    await r.ui('meeting.build', { meetingId: r.meetingId, cardId: c.id, context: 'Keep it small' })
    expect(r.agent.createTask).toHaveBeenCalledTimes(1)
    expect(r.agent.updateTask).toHaveBeenCalledWith({
      path: r.meeting.cards[0]!.taskPath,
      description: expect.stringContaining('- [ ] Columns match'),
    })
    expect(r.agent.updateTask.mock.calls[0]![0].description).toContain('Keep it small')
  })

  it('to a Holi sends it the task, and records its session', async () => {
    const r = await rig()
    await r.say(0)
    await r.say(1)
    const c = await r.card()
    const launches = r.agent.launch.mock.calls.length
    const { value } = await r.ui('meeting.build', {
      meetingId: r.meetingId,
      cardId: c.id,
      context: 'Write it as a proposal',
      target: { kind: 'holi', id: 'proposal' },
    })
    expect(value).toEqual({ sessionId: 'h0l1h0l1' })
    const taskPath = r.meeting.cards[0]!.taskPath!
    expect(r.agent.sendToHoli).toHaveBeenCalledWith({ holi: 'proposal', path: taskPath })
    expect(r.agent.launch.mock.calls).toHaveLength(launches)
    const task = r.agent.createTask.mock.calls[0]![0] as { description: string }
    expect(task.description).toContain('Write it as a proposal')
    expect(r.meeting.cards[0]).toMatchObject({
      status: 'building',
      buildSessionId: 'h0l1h0l1',
      target: { kind: 'holi', id: 'proposal' },
    })
    expect(r.meeting.minutes).toContain('- [ ] Export to CSV (funktion): sendt til proposal')
  })

  it('that is a to-do asks the agent to do or prepare it, not to build software', async () => {
    const r = await rig()
    await r.say(0)
    const c = await r.card({ kind: 'action', prompt: 'Send the offer', lines: [0] })
    await r.ui('meeting.build', { meetingId: r.meetingId, cardId: c.id })
    const args = r.agent.launch.mock.calls.at(-1)![0]
    expect(args.name).toBe('Action · Send the offer')
    expect(args.prompt).toMatch(/^Do or prepare this to-do/)
    expect(args.prompt).not.toContain('## Where')
  })

  it('runs on the vault’s chosen agent: Pi’s background run, or a session of its own', async () => {
    let provider: 'pi' | 'codex' = 'pi'
    const r = await rig({ provider: async () => provider })
    await r.say(0)
    const pi = await r.card({ lines: [0] })
    await r.ui('meeting.build', { meetingId: r.meetingId, cardId: pi.id })
    // Pi gets its own background run, without Claude Code's model or MCP.
    expect(r.agent.launch.mock.calls.at(-1)![0]).toEqual({
      name: 'Build · Export to CSV',
      prompt: expect.any(String),
      provider: 'pi',
    })
    provider = 'codex'
    const codex = await r.card({ lines: [0], prompt: 'Rename the board' })
    const { value } = await r.ui('meeting.build', { meetingId: r.meetingId, cardId: codex.id })
    expect(value).toEqual({ sessionId: 'c0dex000' })
    expect(r.agent.start).toHaveBeenCalledWith({
      name: 'Build · Rename the board',
      prompt: expect.any(String),
      provider: 'codex',
    })
  })

  it('says what the agent cannot do, never running it on another', async () => {
    const r = await rig({ provider: async () => 'codex' })
    r.agent.start.mockResolvedValue({ ok: false, message: 'Codex is not on this machine' })
    await r.say(0)
    const c = await r.card({ lines: [0] })
    expect(await refusal(r.ui('meeting.build', { meetingId: r.meetingId, cardId: c.id }))).toEqual({
      code: 'UNAVAILABLE',
      message: 'Codex is not on this machine',
    })
    expect(r.agent.launch.mock.calls.filter(([a]) => a.name.startsWith('Build'))).toEqual([])
  })

  it('is one send at a time per card: an overlapping one is refused, and nothing runs twice', async () => {
    const r = await rig()
    await r.say(0)
    const c = await r.card({ lines: [0] })
    const send = () => r.ui('meeting.build', { meetingId: r.meetingId, cardId: c.id })
    const [a, b] = await Promise.allSettled([send(), send()])
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(r.agent.createTask).toHaveBeenCalledTimes(1)
    expect(r.agent.launch.mock.calls.filter(([x]) => x.name.startsWith('Build'))).toHaveLength(1)
  })

  it('stops when the task’s file cannot be updated, so nothing runs what it said before', async () => {
    const r = await rig()
    await r.say(0)
    const c = await r.card({ lines: [0] })
    await r.ui('meeting.card', {
      meetingId: r.meetingId,
      cardId: c.id,
      patch: { status: 'accepted' },
    })
    r.agent.updateTask.mockRejectedValue(new Error('the disk is full'))
    const refused = await refusal(
      r.ui('meeting.build', {
        meetingId: r.meetingId,
        cardId: c.id,
        target: { kind: 'holi', id: 'proposal' },
      }),
    )
    expect(refused.code).toBe('UNAVAILABLE')
    expect(refused.message).toContain('nothing was sent')
    expect(r.agent.sendToHoli).not.toHaveBeenCalled()
    expect(r.meeting.cards[0]!.status).not.toBe('building')
  })

  it('after a send that failed, is made again in place from the form as it is now', async () => {
    const r = await rig()
    await r.say(0)
    await r.say(1)
    const c = await r.card({ lines: [0] })
    const again = (
      await r.ui('meeting.task.create', {
        meetingId: r.meetingId,
        lines: [0, 1],
        prompt: 'Export to Excel',
        kind: 'action',
        cardId: c.id,
      })
    ).value as Card
    expect(again).toMatchObject({
      id: c.id,
      why: 'Export to Excel',
      kind: 'action',
      segments: [0, 1],
    })
    expect(r.meeting.cards).toHaveLength(1)
  })

  it('refuses a context over 2000 characters, or a target it does not know', async () => {
    const r = await rig()
    await r.say(0)
    await r.say(1)
    const c = await r.card()
    const send = (extra: Record<string, unknown>) =>
      refusal(r.ui('meeting.build', { meetingId: r.meetingId, cardId: c.id, ...extra }))
    expect(await send({ context: 'x'.repeat(2001) })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await send({ target: { kind: 'robot' } })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await send({ target: { kind: 'holi' } })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(r.agent.launch.mock.calls.filter(([a]) => a.name.startsWith('Build'))).toEqual([])
  })
})

describe('exporting the minutes', () => {
  it('writes the minutes rendered from the groups, under the meeting’s title, where chosen', async () => {
    const r = await rig()
    await r.say(0)
    await r.ui('meeting.group.edit', {
      meetingId: r.meetingId,
      groupId: 't0',
      patch: { decisions: ['Decided'] },
    })
    const out = `${r.root}/Meetings/export.md`
    const { value } = await r.ui('meeting.export', { meetingId: r.meetingId, out })
    expect(value).toEqual({ path: out, vaultPath: 'Meetings/export.md' })
    const written = r.writes.get('Meetings/export.md')!
    // Once, under the meeting's title, in the meeting's language.
    expect(written).toMatch(/^# Planning\n/)
    expect(written.match(/^# /gm)).toHaveLength(1)
    expect(written).toContain('## Drøftelse')
    expect(written).toContain('- Decided')
    expect(
      await refusal(r.ui('meeting.export', { meetingId: r.meetingId, out: 'relative.md' })),
    ).toMatchObject({ code: 'BAD_REQUEST' })
    expect(
      await refusal(r.ui('meeting.export', { meetingId: r.meetingId, out: `${r.root}/x.txt` })),
    ).toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('asking the scribe to change the minutes', () => {
  it('goes at once, framed as a change to the groups, to write with holi meeting group', async () => {
    const r = await rig()
    await r.ui('meeting.tell', {
      meetingId: r.meetingId,
      text: 'Drop the budget talk',
      kind: 'minutes',
    })
    const sent = r.sentTo(SCRIBE).at(-1)!
    expect(sent).toContain('<request>\nDrop the budget talk\n</request>')
    expect(sent).toContain('`holi meeting group`')
    expect(sent).not.toContain('Message from a meeting participant')
  })

  it('is a plain note without a kind, and refuses a kind it does not know', async () => {
    const r = await rig()
    await r.ui('meeting.tell', { meetingId: r.meetingId, text: 'Focus on the export' })
    expect(r.sentTo(SCRIBE).at(-1)).toContain('Message from a meeting participant')
    expect(
      await refusal(r.ui('meeting.tell', { meetingId: r.meetingId, text: 'x', kind: 'shout' })),
    ).toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('a task a person makes', () => {
  it('reaches the scribe in its next batch, once, and is listed as theirs', async () => {
    const r = await rig()
    await r.say(0)
    await r.batch()
    await r.say(1)
    await r.card({ prompt: 'Turn this into a spec for the CI change', lines: [0, 1] })
    const next = await r.batch()
    expect(next).toContain(
      'The person made task c1 »Turn this into a spec for the CI change« from 0:00–0:10.',
    )
    await r.say(2)
    expect(await r.batch()).not.toContain('The person made task')
    const { text } = await r.holi(['context'], null)
    expect(text).toContain('c1\tfeature\tTurn this into a spec for the CI change')
  })

  it(`keeps its first ${MAX_TASK_LINES} lines and says how many it had`, () => {
    const segments: Segment[] = Array.from({ length: 450 }, (_v, i) => ({
      i,
      speaker: 'Me',
      start: i,
      end: i + 0.8,
      text: `line ${i}`,
      chunk: 0,
    }))
    const meeting = { startedAt: 0, segments, cards: [] } as unknown as MeetingState
    const card = taskCard(
      meeting,
      { lines: segments.map((s) => s.i), prompt: 'Sum it up', kind: 'action' },
      1,
    )
    expect(card.segments).toHaveLength(MAX_TASK_LINES)
    expect(card.quotes).toHaveLength(MAX_TASK_LINES)
    expect(card.range).toEqual({ start: 0, end: 449.8, lines: 450 })
  })
})

const spec = (over: Partial<Card>, startedAt = 0) =>
  cardSpec(
    {
      id: 'c1',
      kind: 'feature',
      title: 'Spec it',
      why: 'Spec it',
      segments: [],
      acceptance: [],
      openQuestions: [],
      quotes: [],
      status: 'accepted',
      origin: 'person',
      createdAt: 1,
      updatedAt: 1,
      ...over,
    },
    { meetingTitle: 'Planning', startedAt, minutesPath: 'Meetings/x/minutes.local.md' },
  )

describe('the brief of a task', () => {
  it('dates the meeting by the day this machine held it, not the UTC one', () => {
    const tz = process.env['TZ']
    process.env['TZ'] = 'Pacific/Auckland'
    try {
      const text = spec({}, new Date(2026, 0, 15, 0, 30).getTime())
      expect(text).toContain('"Planning" on 2026-01-15')
    } finally {
      if (tz === undefined) delete process.env['TZ']
      else process.env['TZ'] = tz
    }
  })

  it('says it had more lines than it carries, and stays under its size cap', () => {
    const long = 'word '.repeat(200)
    const quotes = Array.from({ length: 400 }, (_v, i) => ({
      i,
      speaker: 'Them',
      start: i,
      text: `${i} ${long}`,
    }))
    const text = spec({
      segments: quotes.map((q) => q.i),
      quotes,
      range: { start: 0, end: 450, lines: 450 },
    })
    expect(text.length).toBeLessThan(MAX_RANGE_TEXT + 2000)
    expect(text).toMatch(/The task has 450 lines; the first \d+ are here/)
    expect(text).toContain('## What was said from 0:00 to 7:30')
  })

  it('puts lines that are not one stretch under each stretch’s time', () => {
    const quotes = [0, 1, 7, 8, 20].map((i) => ({
      i,
      speaker: 'Me',
      start: i * 10,
      text: `line ${i}`,
    }))
    const text = spec({
      segments: [0, 1, 7, 8, 20],
      quotes,
      range: { start: 0, end: 205, lines: 5 },
    })
    expect(text).toContain('## What was said, in 3 stretches of the meeting')
    expect(text.indexOf('### 0:00')).toBeLessThan(text.indexOf('### 1:10'))
    expect(text.indexOf('### 1:10')).toBeLessThan(text.indexOf('### 3:20'))
    expect(text).toContain('> **Mic audio** (1:20): line 8')
    expect(text).not.toContain('The task has')
  })
})

describe('renaming and deleting a meeting', () => {
  it('renames the title, not the folder, and writes the transcript under the new one', async () => {
    const r = await rig()
    await r.say(0)
    const folder = r.meeting.folder
    const { value } = await r.ui('meeting.rename', {
      meetingId: r.meetingId,
      title: '  Roadmap   review ',
    })
    expect(value).toMatchObject({ id: r.meetingId, title: 'Roadmap review', folder })
    expect(r.meetings.list()[0]!.title).toBe('Roadmap review')
    await until(
      () =>
        r.writes.get(`${folder}/transcript.local.md`)?.includes('\n# Roadmap review\n') === true,
    )
    expect(
      await refusal(r.ui('meeting.rename', { meetingId: r.meetingId, title: '   ' })),
    ).toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('is refused while it records, and once over removes its state and files but not its tasks', async () => {
    const r = await rig()
    await r.say(0)
    await r.say(1)
    await r.card()
    expect(await refusal(r.ui('meeting.delete', { meetingId: r.meetingId }))).toMatchObject({
      code: 'CONFLICT',
    })
    await r.ui('meeting.stop', { meetingId: r.meetingId })
    r.scribe.hearSessions([])
    await until(() => r.meeting.phase === 'done')
    const folder = r.meeting.folder
    await r.ui('meeting.delete', { meetingId: r.meetingId })
    expect(r.meetings.list()).toEqual([])
    expect(r.removed).toEqual([
      {
        rels: [
          `${folder}/transcript.local.md`,
          `${folder}/minutes.local.md`,
          `${folder}/minutes.md`,
        ],
        folder,
      },
    ])
    expect(r.emitted.filter(([name]) => name === 'meetings').at(-1)?.[1]).toEqual([])
    expect(await refusal(r.ui('meeting.get', { meetingId: r.meetingId }))).toMatchObject({
      code: 'NOT_FOUND',
    })
    // Gone from this machine: a reload does not bring it back.
    const again = await engineRig({ userData: r.userData, root: r.root })
    expect(again.meetings.list()).toEqual([])
  })
})

describe('replacing a misheard word', () => {
  it('corrects its first line, or every line, in any case, and skips a line it would empty', async () => {
    const r = await rig()
    await r.say(0)
    await r.say(1)
    const first = (
      await r.ui('meeting.segment.replace', {
        meetingId: r.meetingId,
        find: 'SAID',
        replace: 'told $&',
      })
    ).value as Segment[]
    expect(first.map((s) => [s.i, s.text, s.edited])).toEqual([[0, 'told $& 1', true]])
    expect(r.meeting.segments.map((s) => s.text)).toEqual(['told $& 1', 'said 2'])

    const all = (
      await r.ui('meeting.segment.replace', {
        meetingId: r.meetingId,
        find: 'said',
        replace: 'told',
        all: true,
      })
    ).value as Segment[]
    expect(all.map((s) => s.text)).toEqual(['told 2'])
    expect(r.writes.get(`${r.meeting.folder}/transcript.local.md`)).toContain('told 2')

    const none = await r.ui('meeting.segment.replace', {
      meetingId: r.meetingId,
      find: 'told 2',
      replace: '',
      all: true,
    })
    expect(none.value).toEqual([])
    expect(r.meeting.segments[1]!.text).toBe('told 2')
  })
})
