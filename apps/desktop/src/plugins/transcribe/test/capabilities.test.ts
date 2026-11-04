/**
 * `meeting.*` through the real registry and the CLI's argv reading: what the
 * UI and the scribe may each do (the scribe writes groups, a person reshapes
 * them and makes and sends tasks), the job id the `holi` script fills in,
 * and what is refused. The engine is real, over temporary folders; the agent and
 * the speech service are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveArgv } from '../../../main/bridge/cli'
import { CapabilityError } from '../../../main/capabilities/error'
import {
  createCapabilityRegistry,
  type CapabilityContext,
} from '../../../main/capabilities/registry'
import type { Card, MeetingState, Topic } from '../shared/meeting'
import { meetingCapabilities, MEETING_NAMESPACES } from '../main/capabilities'
import { MAX_CARDS, MAX_TASK_LINES } from '../main/cards'
import type { Related } from '../main/related'
import type { Profiles } from '../main/profiles'
import { chunkWav, engineRig, SCRIBE, until } from './engine-helpers'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const OTHER = 'ffff0000'

async function rig() {
  const engine = await engineRig({
    launch: async (args) => ({
      ok: true,
      sessionId: args.name.startsWith('Build') ? 'b0b0b0b0' : SCRIBE,
    }),
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
  /** A `holi meeting …` command as the script sends it from inside `job`. */
  const holi = async (argv: string[], stdin: string | null, job: string | null = SCRIBE) => {
    const request = resolveArgv(['meeting', ...argv], registry.commands(), stdin, job)
    if (request.kind !== 'run') throw new Error(`not a run: ${JSON.stringify(request)}`)
    return registry.run(request.name, 'cli', ctx, request.params)
  }
  const { value } = await ui('meeting.start', { title: 'Planning', profileId: 'default' })
  const meetingId = (value as { meetingId: string }).meetingId
  const meeting = (await ui('meeting.get', { meetingId })).value as MeetingState
  await until(() => meeting.scribeSessionId === SCRIBE)
  // Six lines, [n] at 8n + 0.5 to 8n + 2.5 s, Me on the even ones.
  for (const n of [0, 1, 2, 3, 4, 5]) {
    await ui('meeting.chunk', {
      meetingId,
      n,
      start: n * 8,
      duration: 8,
      audio: Buffer.from(chunkWav(8, n % 2 === 0 ? 'me' : 'them')).toString('base64'),
    })
  }
  await until(() => meeting.segments.length === 6)
  // As if a batch had carried them all to the scribe.
  meeting.scribeCursor = 5
  /** The scribe writes a group. */
  const group = (over: Record<string, unknown> = {}) =>
    holi(['group'], groupJson(over)).then((r) => r as { value: { topic: Topic }; text: string })
  return { ...engine, registry, ui, holi, group, meetingId, meeting, ctx }
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

function groupJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    startIndex: 0,
    title: 'Export',
    keywords: ['csv', 'export'],
    ...over,
  })
}

describe('the doors', () => {
  it('registers the meeting verbs, the scribe’s two at the CLI door', () => {
    const registry = createCapabilityRegistry()
    registry.register(
      MEETING_NAMESPACES,
      meetingCapabilities({
        meetings: {} as never,
        profiles: {} as never,
        speechKey: {} as never,
        services: {} as never,
        serviceChanged: () => {},
        remote: 'syv/vault',
      }),
    )
    expect(registry.names('ui').sort()).toEqual([
      'meeting.build',
      'meeting.card',
      'meeting.chunk',
      'meeting.chunk.lost',
      'meeting.delete',
      'meeting.export',
      'meeting.get',
      'meeting.group.edit',
      'meeting.group.join',
      'meeting.group.merge',
      'meeting.group.separate',
      'meeting.group.split',
      'meeting.key.clear',
      'meeting.key.set',
      'meeting.key.status',
      'meeting.key.test',
      'meeting.list',
      'meeting.prepare',
      'meeting.profiles.delete',
      'meeting.profiles.list',
      'meeting.profiles.save',
      'meeting.related',
      'meeting.rename',
      'meeting.scribe.restart',
      'meeting.segment.edit',
      'meeting.segment.replace',
      'meeting.service.set',
      'meeting.start',
      'meeting.stop',
      'meeting.summarise',
      'meeting.task.create',
      'meeting.tell',
    ])
    expect(registry.names('cli').sort()).toEqual(['meeting.context', 'meeting.group'])
    expect(registry.names('app')).toEqual([])
  })

  it('fills the calling session in from the job, and reads the body from stdin', async () => {
    const r = await rig()
    expect(resolveArgv(['meeting', 'group'], r.registry.commands(), null, SCRIBE)).toEqual({
      kind: 'stdin',
    })
    const run = resolveArgv(['meeting', 'group'], r.registry.commands(), groupJson(), SCRIBE)
    expect(run).toMatchObject({ kind: 'run', params: { session: SCRIBE, json: groupJson() } })
  })

  it('takes the JSON as the argument too, but not twice', async () => {
    const r = await rig()
    const request = resolveArgv(
      ['meeting', 'group', groupJson()],
      r.registry.commands(),
      null,
      SCRIBE,
    )
    expect(request).toMatchObject({ kind: 'run', params: { json: groupJson(), session: SCRIBE } })
    await r.holi(['group', groupJson()], null)
    expect(r.meeting.topics[0]!.title).toBe('Export')
    const twice = resolveArgv(
      ['meeting', 'group', groupJson(), `--json=${groupJson({ title: 'Other' })}`],
      r.registry.commands(),
      null,
      SCRIBE,
    )
    expect(twice).toMatchObject({ kind: 'usage', text: expect.stringContaining('given twice') })
  })

  it('refuses another session naming the scribe with --session', async () => {
    const r = await rig()
    for (const verb of ['group', 'context']) {
      const request = resolveArgv(
        ['meeting', verb, `--session=${SCRIBE}`],
        r.registry.commands(),
        '{}',
        OTHER,
      )
      expect(request, verb).toMatchObject({
        kind: 'usage',
        text: expect.stringContaining('--session names another session'),
      })
    }
  })

  it('takes no card from the CLI: a card is a person’s, from the UI', async () => {
    const r = await rig()
    const request = resolveArgv(['meeting', 'card'], r.registry.commands(), '{}', SCRIBE)
    expect(request.kind).not.toBe('run')
  })

  it('refuses a call about another vault', async () => {
    const r = await rig()
    const elsewhere = { ...r.ctx, remote: 'someone/else' }
    expect(await refusal(r.registry.run('meeting.list', 'ui', elsewhere, {}))).toMatchObject({
      code: 'UNAVAILABLE',
    })
  })
})

describe('the scribe’s verbs', () => {
  it('are refused for any session that is not the meeting’s scribe', async () => {
    const r = await rig()
    expect(await refusal(r.holi(['group'], groupJson(), OTHER))).toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(await refusal(r.holi(['context'], null, OTHER))).toMatchObject({ code: 'FORBIDDEN' })
    // Outside a session there is no job at all.
    expect(await refusal(r.holi(['context'], null, null))).toMatchObject({ code: 'BAD_REQUEST' })
    expect(r.meeting.topics[0]!.title).toBe('')
  })

  it('are refused once the meeting is done', async () => {
    const r = await rig()
    await r.ui('meeting.stop', { meetingId: r.meetingId })
    r.meetings.scribe.hearSessions([])
    await until(() => r.meeting.phase === 'done')
    expect(await refusal(r.group())).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('a group from the scribe', () => {
  it('writes the group its start names, lines and times derived by code', async () => {
    const r = await rig()
    const { value, text } = await r.group({
      summary: ['Finance wants a CSV'],
      decisions: ['CSV first'],
      suggestions: [{ kind: 'feature', title: 'Export to CSV', why: 'Asked', segments: [1] }],
    })
    expect(value.topic).toMatchObject({
      id: 't0',
      title: 'Export',
      lines: [0, 1, 2, 3, 4, 5],
      start: 0.5,
      end: 42.5,
      open: true,
      summary: ['Finance wants a CSV'],
      decisions: ['CSV first'],
      suggestions: [{ id: 's1', kind: 'feature', title: 'Export to CSV', segments: [1] }],
    })
    expect(JSON.parse(text)).toEqual({
      startIndex: 0,
      lines: [0, 5],
      open: true,
      title: 'Export',
      suggestions: [{ id: 's1', title: 'Export to CSV' }],
    })
    expect(r.meeting.minutesAt).toBe(Date.now())
  })

  it('starting at a line of the open group cuts it there; inside a closed one is refused', async () => {
    const r = await rig()
    await r.group({ startIndex: 3, title: 'Budget' })
    expect(r.meeting.topics.map((t) => [t.id, t.lines, t.open, t.stale])).toEqual([
      ['t0', [0, 1, 2], false, true],
      ['t3', [3, 4, 5], true, undefined],
    ])
    expect(r.meeting.topics[0]!.end).toBe(18.5)
    // Writing the closed one in full clears its mark.
    await r.group({ summary: ['Who wants a CSV'] })
    expect(r.meeting.topics[0]!.stale).toBeUndefined()
    expect(await refusal(r.group({ startIndex: 1 }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('closed group [0]'),
    })
    expect(r.meeting.topics).toHaveLength(2)
  })

  it('keeps fields left out', async () => {
    const r = await rig()
    await r.group({ summary: ['One'], questions: ['Which columns?'] })
    await r.group({ title: 'CSV export' })
    expect(r.meeting.topics[0]).toMatchObject({
      title: 'CSV export',
      summary: ['One'],
      questions: ['Which columns?'],
    })
  })

  it('is checked: fields, title, keywords, its start, and what a suggestion cites', async () => {
    const r = await rig()
    const bad = async (over: Record<string, unknown>) => refusal(r.group(over))
    expect(await bad({ colour: 'red' })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await bad({ title: ' ' })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await bad({ keywords: ['csv'] })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await bad({ startIndex: -2 })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await refusal(r.holi(['group'], 'not json'))).toMatchObject({ code: 'BAD_REQUEST' })
    // A line it was not sent yet.
    r.meeting.scribeCursor = 3
    expect(await bad({ startIndex: 4 })).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('not one you were sent'),
    })
    // A suggestion citing a later group's line, or one the meeting does not have.
    r.meeting.scribeCursor = 5
    await r.group({ startIndex: 3, title: 'Budget' })
    const later = { kind: 'feature', title: 'X', why: '', segments: [4] }
    expect(await bad({ suggestions: [later] })).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('not in this group or an earlier one'),
    })
    expect(await bad({ startIndex: 3, suggestions: [{ ...later, segments: [9] }] })).toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(r.meeting.topics[0]!.suggestions).toEqual([])
  })

  it('keeps a suggestion a person sent when the scribe drops it', async () => {
    const r = await rig()
    await r.group({
      suggestions: [
        { kind: 'feature', title: 'Export to CSV', why: '', segments: [1] },
        { kind: 'feature', title: 'Search', why: '', segments: [2] },
      ],
    })
    await r.ui('meeting.task.create', {
      meetingId: r.meetingId,
      lines: [1],
      prompt: 'Build the CSV export',
      kind: 'feature',
      from: { topicId: 't0', suggestionId: 's1' },
    })
    await r.group({ suggestions: [] })
    expect(r.meeting.topics[0]!.suggestions.map((s) => s.id)).toEqual(['s1'])
  })

  it('leaves the fields a person edited, and says so', async () => {
    const r = await rig()
    await r.group({ summary: ['Theirs'] })
    const { value } = await r.ui('meeting.group.edit', {
      meetingId: r.meetingId,
      groupId: 't0',
      patch: { title: 'CSV for finance', summary: ['Mine'] },
    })
    expect(value).toMatchObject({
      title: 'CSV for finance',
      summary: ['Mine'],
      edited: ['title', 'summary'],
      editedAt: Date.now(),
    })
    const { text } = await r.group({
      title: 'Export',
      summary: ['Theirs again'],
      decisions: ['Go'],
    })
    expect(r.meeting.topics[0]).toMatchObject({
      title: 'CSV for finance',
      summary: ['Mine'],
      decisions: ['Go'],
    })
    expect(text).toContain('not changed: title, summary')
    expect(r.meeting.minutes).toContain('### Nu: CSV for finance')
  })
})

describe('the context', () => {
  it('lists the groups, open, unwritten and edited, the person’s tasks and the last line', async () => {
    const r = await rig()
    await r.group({ startIndex: 3, title: 'Budget' })
    await r.ui('meeting.group.edit', {
      meetingId: r.meetingId,
      groupId: 't3',
      patch: { keywords: ['money', 'cost'] },
    })
    await r.ui('meeting.task.create', {
      meetingId: r.meetingId,
      lines: [0, 1],
      prompt: 'Spec the export',
      kind: 'feature',
    })
    const { value, text } = await r.holi(['context'], null)
    expect(value).toMatchObject({
      lastSegment: 5,
      profile: { name: 'Default' },
      groups: [
        { startIndex: 0, title: '', open: false, stale: true, edited: [] },
        { startIndex: 3, title: 'Budget', open: true, stale: false, edited: ['keywords'] },
      ],
      tasks: [{ id: 'c1', kind: 'feature', title: 'Spec the export', status: 'accepted' }],
    })
    expect(text).toContain('last segment: 5')
    expect(text).toContain('  0\t(untitled)\t(not written: write it in full)')
    expect(text).toContain('  3\tBudget\t(open)\t(the person’s: keywords)')
    expect(text).toContain('  c1\tfeature\tSpec the export')
  })
})

describe('a person reshapes the groups', () => {
  it('splits one at a line, and merges one into the one before', async () => {
    const r = await rig()
    await r.group({ summary: ['All of it'] })
    const split = (await r.ui('meeting.group.split', { meetingId: r.meetingId, i: 2 }))
      .value as Topic[]
    expect(split.map((t) => [t.id, t.lines, t.open, t.stale === true])).toEqual([
      ['t0', [0, 1], false, true],
      ['t2', [2, 3, 4, 5], true, false],
    ])
    expect(r.meeting.topics).toEqual(split)
    const merged = (await r.ui('meeting.group.merge', { meetingId: r.meetingId, groupId: 't2' }))
      .value as Topic[]
    expect(merged.map((t) => [t.id, t.lines, t.open])).toEqual([['t0', [0, 1, 2, 3, 4, 5], true]])
  })

  it('is refused at a group’s first line, the first group’s merge, or what does not exist', async () => {
    const r = await rig()
    const ui = (name: string, params: Record<string, unknown>) =>
      refusal(r.ui(name, { meetingId: r.meetingId, ...params }))
    expect(await ui('meeting.group.split', { i: 0 })).toMatchObject({ code: 'CONFLICT' })
    expect(await ui('meeting.group.split', { i: 40 })).toMatchObject({ code: 'NOT_FOUND' })
    expect(await ui('meeting.group.split', { i: 1.5 })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await ui('meeting.group.merge', { groupId: 't0' })).toMatchObject({ code: 'CONFLICT' })
    expect(await ui('meeting.group.merge', { groupId: 't9' })).toMatchObject({ code: 'NOT_FOUND' })
    expect(await ui('meeting.group.edit', { groupId: 't9', patch: { title: 'x' } })).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(await ui('meeting.group.edit', { groupId: 't0', patch: { lines: [1] } })).toMatchObject({
      code: 'BAD_REQUEST',
    })
  })
})

describe('a task a person makes', () => {
  const create = (r: Awaited<ReturnType<typeof rig>>, over: Record<string, unknown> = {}) =>
    r.ui('meeting.task.create', {
      meetingId: r.meetingId,
      lines: [3, 1, 3, 2],
      prompt: 'Turn this into a spec for the CI change\nKeep it short',
      kind: 'feature',
      ...over,
    })

  it('carries its lines, sorted and once, quoted by code; accepted and the person’s', async () => {
    const r = await rig()
    const card = (await create(r, { from: { topicId: 't0' } })).value as Card
    expect(card).toMatchObject({
      id: 'c1',
      kind: 'feature',
      title: 'Turn this into a spec for the CI change',
      why: 'Turn this into a spec for the CI change\nKeep it short',
      segments: [1, 2, 3],
      status: 'accepted',
      origin: 'person',
      from: { topicId: 't0' },
      range: { start: 8.5, end: 26.5, lines: 3 },
    })
    expect(card.quotes.map((q) => [q.i, q.speaker, q.text])).toEqual(
      [1, 2, 3].map((i) => [i, r.meeting.segments[i]!.speaker, r.meeting.segments[i]!.text]),
    )
    expect(r.meeting.cards).toEqual([card])
  })

  it('takes a title given, else the ask’s first line cut to 80 characters', async () => {
    const r = await rig()
    expect(((await create(r, { title: 'CI spec' })).value as Card).title).toBe('CI spec')
    const long = ((await create(r, { prompt: `${'word '.repeat(30)}\nmore` })).value as Card).title
    expect(long).toHaveLength(80)
    expect(long.endsWith('…')).toBe(true)
  })

  it('is refused without lines, a line the meeting lacks, an ask, or a kind', async () => {
    const r = await rig()
    const no = (over: Record<string, unknown>) => refusal(create(r, over))
    expect(await no({ lines: [] })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await no({ lines: [1, 99] })).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('line 99'),
    })
    expect(await no({ lines: [-1] })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await no({ lines: 'all' })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await no({ prompt: '   ' })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await no({ prompt: 'x'.repeat(2001) })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await no({ kind: 'epic' })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await no({ from: 't0' })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(r.meeting.cards).toEqual([])
  })

  it(`stops at ${MAX_CARDS} tasks a meeting`, async () => {
    const r = await rig()
    for (let k = 0; k < MAX_CARDS; k++) await create(r, { prompt: `Task ${k}` })
    expect(await refusal(create(r))).toMatchObject({ code: 'BAD_REQUEST' })
    expect(r.meeting.cards).toHaveLength(MAX_CARDS)
  })

  it(`keeps its first ${MAX_TASK_LINES} lines, and says how many it had`, async () => {
    const r = await rig()
    // More lines than a task holds: the meeting's six, many times over, is not
    // allowed (unknown lines), so pad the meeting itself.
    for (let i = 6; i < 450; i++) {
      r.meeting.segments.push({
        i,
        speaker: 'Me',
        start: 50 + i,
        end: 50.5 + i,
        text: `line ${i}`,
        chunk: 6,
      })
    }
    const lines = r.meeting.segments.map((s) => s.i)
    const card = (await create(r, { lines })).value as Card
    expect(card.segments).toHaveLength(MAX_TASK_LINES)
    expect(card.quotes).toHaveLength(MAX_TASK_LINES)
    expect(card.range).toEqual({ start: 0.5, end: 499.5, lines: 450 })
  })
})

describe('related lines', () => {
  it('rank the meeting’s windows outside the ones excluded', async () => {
    const r = await rig()
    // The fake service says "said N" on line N - 1.
    const { value } = await r.ui('meeting.related', {
      meetingId: r.meetingId,
      query: 'said',
      exclude: [0, 1, 2],
    })
    const found = value as Related[]
    expect(found.length).toBeGreaterThan(0)
    expect(found.flatMap((w) => w.lines).some((i) => i < 3)).toBe(false)
    expect(
      (await r.ui('meeting.related', { meetingId: r.meetingId, query: 'kubernetes' }))
        .value as Related[],
    ).toEqual([])
  })

  it('checks its params', async () => {
    const r = await rig()
    const no = (params: Record<string, unknown>) =>
      refusal(r.ui('meeting.related', { meetingId: r.meetingId, ...params }))
    expect(await no({})).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await no({ query: 'x'.repeat(4001) })).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await no({ query: 'csv', exclude: ['a'] })).toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('a person’s task changes', () => {
  it('in its words and owner; it cannot be set building, or take a field it lacks', async () => {
    const r = await rig()
    const card = (
      await r.ui('meeting.task.create', {
        meetingId: r.meetingId,
        lines: [0],
        prompt: 'Export',
        kind: 'feature',
      })
    ).value as Card
    const patch = (p: unknown) =>
      r.ui('meeting.card', { meetingId: r.meetingId, cardId: card.id, patch: p })
    expect((await patch({ title: 'CSV export', owner: 'Nikolaj' })).value).toMatchObject({
      title: 'CSV export',
      owner: 'Nikolaj',
    })
    expect((await patch({ status: 'dismissed' })).value).toMatchObject({ status: 'dismissed' })
    for (const p of [{ status: 'building' }, { status: 'suggested' }, { quotes: [] }]) {
      expect(await refusal(patch(p)), JSON.stringify(p)).toMatchObject({ code: 'BAD_REQUEST' })
    }
    expect(
      await refusal(r.ui('meeting.card', { meetingId: r.meetingId, cardId: 'c9', patch: {} })),
    ).toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('sending a task', () => {
  it('makes its task and starts a session whose brief has every line and the group', async () => {
    const r = await rig()
    await r.group({ startIndex: 3, title: 'Budget' })
    await r.group({ summary: ['Finance wants a CSV', 'Columns are open'] })
    const card = (
      await r.ui('meeting.task.create', {
        meetingId: r.meetingId,
        lines: [0, 1, 2, 5],
        prompt: 'Build the CSV export',
        kind: 'feature',
        from: { topicId: 't0' },
      })
    ).value as Card
    const { value } = await r.ui('meeting.build', { meetingId: r.meetingId, cardId: card.id })
    expect(value).toEqual({ sessionId: 'b0b0b0b0' })
    const args = r.agent.launch.mock.calls.at(-1)![0]
    expect(args.name).toBe('Build · Build the CSV export')
    expect(args.allow).toBeUndefined()
    expect(args.prompt).toContain(`@${r.meeting.cards[0]!.taskPath}`)
    expect(args.prompt).toContain('## What the person asks\n\nBuild the CSV export')
    // The group it came from, as it reads now.
    expect(args.prompt).toContain('**Export** (0:00–0:18)')
    expect(args.prompt).toContain('- Finance wants a CSV')
    // Every line, in its stretches: 0–2, then 5.
    expect(args.prompt).toContain('## What was said, in 2 stretches of the meeting')
    for (const i of [0, 1, 2, 5]) expect(args.prompt).toContain(r.meeting.segments[i]!.text)
    expect(args.prompt).not.toContain(`(0:24): ${r.meeting.segments[3]!.text}`)
    expect(args.prompt).toContain('minutes.local.md')
    const task = r.agent.createTask.mock.calls[0]![0] as { description: string }
    expect(task.description).toContain('**Export** (0:00–0:18)')
    expect(r.meeting.cards[0]).toMatchObject({ status: 'building', buildSessionId: 'b0b0b0b0' })
    expect(r.meeting.minutes).toContain('- [ ] Build the CSV export (funktion): sendt til agenten')
    expect(
      await refusal(r.ui('meeting.build', { meetingId: r.meetingId, cardId: card.id })),
    ).toMatchObject({ code: 'CONFLICT' })
  })
})

describe('the UI’s params', () => {
  it('are checked', async () => {
    const r = await rig()
    expect(
      await refusal(
        r.ui('meeting.chunk', { meetingId: r.meetingId, n: -1, start: 0, duration: 1, audio: '' }),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST' })
    expect(
      await refusal(
        r.ui('meeting.chunk', {
          meetingId: r.meetingId,
          n: 9,
          start: 0,
          duration: 1,
          audio: '%%%',
        }),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST' })
    expect(
      await refusal(r.ui('meeting.tell', { meetingId: r.meetingId, text: '  ' })),
    ).toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(await refusal(r.ui('meeting.get', { meetingId: 'nope' }))).toMatchObject({
      code: 'NOT_FOUND',
    })
    // A meeting needs no profile, but goes in no folder outside the vault,
    // and in no other meeting.
    expect(await refusal(r.ui('meeting.start', { folder: '../out' }))).toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(
      await refusal(r.ui('meeting.start', { folder: 'Clients/A.meeting/inside' })),
    ).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await refusal(r.ui('meeting.start', { path: 'Clients/no-suffix' }))).toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(await refusal(r.ui('meeting.profiles.save', { profile: { name: '' } }))).toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('a chunk number already in is refused rather than overwritten', async () => {
    const r = await rig()
    const again = refusal(
      r.ui('meeting.chunk', {
        meetingId: r.meetingId,
        n: 0,
        start: 0,
        duration: 8,
        audio: Buffer.from(chunkWav(1)).toString('base64'),
      }),
    )
    expect(await again).toMatchObject({ code: 'CONFLICT' })
  })
})

describe('groups and new lines', () => {
  it('new lines join the open group while the meeting records, and head the transcript file', async () => {
    const r = await rig()
    await r.group({ startIndex: 3, title: 'Budget' })
    await r.ui('meeting.chunk', {
      meetingId: r.meetingId,
      n: 6,
      start: 48,
      duration: 8,
      audio: Buffer.from(chunkWav(8, 'me')).toString('base64'),
    })
    await until(() => r.meeting.segments.length === 7)
    expect(r.meeting.topics.map((t) => [t.id, t.lines, t.end])).toEqual([
      ['t0', [0, 1, 2], 18.5],
      ['t3', [3, 4, 5, 6], 50.5],
    ])
    await until(() =>
      [...r.writes.entries()].some(
        ([k, v]) => k.endsWith('transcript.local.md') && v.includes('## Budget · 0:24'),
      ),
    )
    const file = [...r.writes.entries()].find(([k]) => k.endsWith('transcript.local.md'))![1]
    expect(file.indexOf('## Untitled · 0:00')).toBeLessThan(file.indexOf('## Budget · 0:24'))
  })
})
