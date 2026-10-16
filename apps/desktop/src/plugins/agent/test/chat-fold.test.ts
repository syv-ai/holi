/**
 * How a conversation's entries fold into the chat's items: results paired to
 * calls by id whatever order they came in, background reports joined, the task
 * list rebuilt, and unchanged items keeping their identity between refreshes.
 */
import { describe, expect, test } from 'vitest'
import { foldEntries } from '../renderer/chat/fold'
import type { ChatEntry, ChatItem, ToolItem } from '../renderer/chat/items'

const call = (id: string, name = 'Bash', args: Record<string, unknown> = {}): ChatEntry => ({
  kind: 'tool',
  id,
  name,
  summary: `${name} ${id}`,
  args,
})
const result = (
  id: string,
  text = 'out',
  ok = true,
  data?: Record<string, unknown>,
): ChatEntry => ({
  kind: 'tool-result',
  id,
  ok,
  text,
  ...(data === undefined ? {} : { data }),
})
const user = (id: string): ChatEntry => ({ kind: 'user', id, text: `say ${id}` })
const tools = (items: readonly ChatItem[]): ToolItem[] =>
  items.filter((i): i is ToolItem => i.kind === 'tool')

describe('pairing a result with its call', () => {
  test('a call with no result is pending, with one it is done', () => {
    const [pending] = tools(foldEntries([call('a')]).items)
    expect(pending?.state).toBe('pending')
    expect(pending?.result).toBeUndefined()
    const [done] = tools(foldEntries([call('a'), result('a', 'fine')]).items)
    expect(done?.state).toBe('done')
    expect(done?.result).toMatchObject({ ok: true, text: 'fine' })
    expect(done?.orphan).toBeUndefined()
  })

  test('parallel calls whose results come out of order and between the calls', () => {
    const { items } = foldEntries([
      user('u'),
      call('a'),
      result('b', 'B out'), // before its own call line
      call('b'),
      call('c'),
      result('c', 'C out'),
      result('a', 'A out'),
    ])
    expect(items.map((i) => i.id)).toEqual(['u', 'a', 'b', 'c'])
    const [a, b, c] = tools(items)
    expect([a?.result?.text, b?.result?.text, c?.result?.text]).toEqual(['A out', 'B out', 'C out'])
    expect(tools(items).every((t) => t.state === 'done' && t.orphan === undefined)).toBe(true)
  })

  test('a result with no call anywhere is an orphan named "result"', () => {
    const { items } = foldEntries([user('u'), result('lost', 'late', false)])
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({
      kind: 'tool',
      id: 'lost',
      name: 'result',
      orphan: true,
      state: 'error',
      result: { ok: false, text: 'late' },
    })
  })

  test('is_error false is done, ok false an error', () => {
    const { items } = foldEntries([call('a'), result('a', 'x', false)])
    expect(tools(items)[0]?.state).toBe('error')
  })
})

describe('a refused call', () => {
  const REJECT = "The user doesn't want to proceed with this tool use. The tool use was rejected."
  test('by the rejection text', () => {
    const { items } = foldEntries([call('a'), result('a', REJECT, false)])
    expect(tools(items)[0]?.state).toBe('rejected')
  })
  test('by an interrupt for the tool right after its failed result', () => {
    const { items } = foldEntries([
      call('a'),
      result('a', '[Request interrupted by user for tool use]', false),
      { kind: 'interrupt', id: 'i', forTool: true },
    ])
    expect(tools(items)[0]?.state).toBe('rejected')
  })
  test('an interrupt of a reply, or after a result that succeeded, refuses nothing', () => {
    const a = foldEntries([
      call('a'),
      result('a', 'nope', false),
      { kind: 'interrupt', id: 'i', forTool: false },
    ])
    expect(tools(a.items)[0]?.state).toBe('error')
    const b = foldEntries([
      call('a'),
      result('a', 'fine'),
      { kind: 'interrupt', id: 'i', forTool: true },
    ])
    expect(tools(b.items)[0]?.state).toBe('done')
  })
})

describe('a background task reporting', () => {
  const note = (toolUseId: string | undefined, status: string): ChatEntry => ({
    kind: 'task-note',
    id: `n-${status}`,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    status,
    summary: `it ${status}`,
  })
  test('joins the call that started it, and is not a row of its own', () => {
    const { items } = foldEntries([
      call('agent', 'Agent'),
      result('agent', 'Async agent launched'),
      user('u'),
      note('agent', 'completed'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['tool', 'user'])
    expect(tools(items)[0]?.note).toMatchObject({ status: 'completed', summary: 'it completed' })
    expect(tools(items)[0]?.state).toBe('done')
  })
  test('the latest report on a call is the one kept, and one before its call joins too', () => {
    const { items } = foldEntries([
      note('agent', 'running'),
      call('agent', 'Agent'),
      note('agent', 'completed'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['tool'])
    expect(tools(items)[0]?.note?.status).toBe('completed')
  })
  test('a report on no call here, or on none at all, stays a row', () => {
    const { items } = foldEntries([note('elsewhere', 'completed'), note(undefined, 'failed')])
    expect(items.map((i) => i.kind)).toEqual(['task-note', 'task-note'])
  })
  test('joins an orphan result', () => {
    const { items } = foldEntries([result('agent', 'launched'), note('agent', 'completed')])
    expect(items).toHaveLength(1)
    expect(tools(items)[0]).toMatchObject({ orphan: true })
    expect(tools(items)[0]?.note?.status).toBe('completed')
  })
})

describe('the task list', () => {
  const create = (id: string, subject: string, n: number | string = id): ChatEntry[] => [
    call(`c${id}`, 'TaskCreate', { subject }),
    result(`c${id}`, `Task #${n} created successfully: ${subject}`, true, {
      task: { id: String(n), subject },
    }),
  ]
  const update = (callId: string, args: Record<string, unknown>): ChatEntry[] => [
    call(callId, 'TaskUpdate', args),
    result(callId, 'Updated task'),
  ]

  test('is made by creates and moved on by updates', () => {
    const { tasks } = foldEntries([
      ...create('1', 'Write the doc'),
      ...create('2', 'Review it'),
      ...update('u1', { taskId: '1', status: 'in_progress' }),
      ...update('u2', { taskId: 2, status: 'completed' }), // a number id
    ])
    expect([...tasks.values()]).toEqual([
      { id: '1', subject: 'Write the doc', status: 'in_progress' },
      { id: '2', subject: 'Review it', status: 'completed' },
    ])
  })
  test('takes a created task id from the result text when there is no structured twin', () => {
    const { tasks } = foldEntries([
      call('c', 'TaskCreate', { subject: 'Plain' }),
      result('c', 'Task #7 created successfully: Plain'),
    ])
    expect(tasks.get('7')).toEqual({ id: '7', subject: 'Plain', status: 'pending' })
  })
  test('a create with no result has no id yet, a failed or refused call changes nothing', () => {
    const { tasks } = foldEntries([
      call('c', 'TaskCreate', { subject: 'No id yet' }),
      ...create('1', 'Real'),
      call('u', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      result('u', 'denied', false),
    ])
    expect([...tasks.keys()]).toEqual(['1'])
    expect(tasks.get('1')?.status).toBe('pending')
  })
  test('a deleted task goes; an update to one from an earlier part still shows', () => {
    const { tasks } = foldEntries([
      ...create('1', 'Gone'),
      ...update('d', { taskId: '1', status: 'deleted' }),
      ...update('e', { taskId: '9', status: 'completed' }),
    ])
    expect([...tasks.values()]).toEqual([{ id: '9', subject: 'Task 9', status: 'completed' }])
  })
  test('malformed calls are ignored', () => {
    const { tasks } = foldEntries([
      call('a', 'TaskUpdate', { taskId: { nope: 1 }, status: 'completed' }),
      call('b', 'TaskUpdate'),
      call('c', 'TaskCreate', { subject: 7 }),
      result('c', 'Task #1 created successfully: 7'),
      call('d', 'TodoWrite', { todos: 'nope' }),
      call('e', 'TodoWrite', { todos: [null, 3, { status: 'pending' }] }),
    ])
    expect(tasks.size).toBe(0)
  })
  test('TodoWrite replaces its list whole', () => {
    const { tasks } = foldEntries([
      call('t1', 'TodoWrite', { todos: [{ content: 'one', status: 'pending' }] }),
      call('t2', 'TodoWrite', {
        todos: [
          { content: 'one', status: 'completed' },
          { content: 'two', status: 'in_progress' },
        ],
      }),
    ])
    expect([...tasks.values()].map((t) => [t.subject, t.status])).toEqual([
      ['one', 'completed'],
      ['two', 'in_progress'],
    ])
  })
  test('tasks keep their identity when nothing about them changed', () => {
    const entries = [...create('1', 'A')]
    const first = foldEntries(entries)
    const next = foldEntries([...entries, user('u')], first.cache)
    expect(next.tasks).toBe(first.tasks)
  })
})

describe('the same entry read twice', () => {
  test('a replay after a resume does not repeat anything', () => {
    const once = [user('u'), call('a'), result('a'), { kind: 'assistant', id: 'x', text: 'ok' }]
    const { items } = foldEntries([...once, ...once] as ChatEntry[])
    expect(items.map((i) => i.id)).toEqual(['u', 'a', 'x'])
  })
  test('a user entry and an assistant entry with one id are two', () => {
    const { items } = foldEntries([
      user('1'),
      { kind: 'assistant', id: '1', text: 'hi' },
    ] as ChatEntry[])
    expect(items).toHaveLength(2)
  })
})

describe('an earlier part loaded later', () => {
  test('completes a pair across the boundary', () => {
    const later = [result('a', 'done late'), user('u2')]
    const before = foldEntries(later)
    expect(tools(before.items)[0]).toMatchObject({ orphan: true, name: 'result' })
    const after = foldEntries([user('u1'), call('a', 'Read'), ...later], before.cache)
    expect(after.items.map((i) => i.id)).toEqual(['u1', 'a', 'u2'])
    const [t] = tools(after.items)
    expect(t).toMatchObject({ name: 'Read', state: 'done', result: { text: 'done late' } })
    expect(t?.orphan).toBeUndefined()
    // The row after the boundary is the very same object.
    expect(after.items[2]).toBe(before.items[1])
  })
})

describe('identity between refreshes', () => {
  test('an unchanged refresh is the same list, a new tail changes only the tail', () => {
    const entries = [user('u'), call('a'), result('a'), call('b')]
    const first = foldEntries(entries)
    const same = foldEntries(entries, first.cache)
    expect(same.items).toBe(first.items)
    const grown = foldEntries([...entries, user('v')], first.cache)
    expect(grown.items).not.toBe(first.items)
    first.items.forEach((item, i) => expect(grown.items[i]).toBe(item))
  })
  test('a result arriving replaces that one tool item only', () => {
    const entries = [user('u'), call('a'), result('a'), call('b'), call('c')]
    const first = foldEntries(entries)
    const next = foldEntries([...entries, result('b', 'B')], first.cache)
    expect(next.items[0]).toBe(first.items[0])
    expect(next.items[1]).toBe(first.items[1])
    expect(next.items[2]).not.toBe(first.items[2])
    expect(tools(next.items)[1]?.state).toBe('done')
    expect(next.items[3]).toBe(first.items[3])
  })
  test('a note arriving replaces the one tool it joins', () => {
    const entries = [call('a', 'Agent'), result('a'), call('b')]
    const first = foldEntries(entries)
    const next = foldEntries(
      [
        ...entries,
        { kind: 'task-note', id: 'n', toolUseId: 'a', status: 'completed', summary: 's' },
      ],
      first.cache,
    )
    expect(next.items[0]).not.toBe(first.items[0])
    expect(next.items[1]).toBe(first.items[1])
  })
  test('equal entries from a fresh read keep the cached items', () => {
    const make = (): ChatEntry[] => [user('u'), { kind: 'assistant', id: 'x', text: 'ok' }]
    const first = foldEntries(make())
    const again = foldEntries(make(), first.cache)
    expect(again.items).toBe(first.items)
  })
  test('5000 entries refreshed with 1 new one: a handful replaced, well under 50 ms', () => {
    const entries: ChatEntry[] = []
    for (let i = 0; i < 1250; i++) {
      entries.push(user(`u${i}`), call(`t${i}`, 'Bash', { command: 'ls' }), result(`t${i}`, 'ok'))
      entries.push({ kind: 'assistant', id: `a${i}`, text: 'done' })
    }
    expect(entries).toHaveLength(5000)
    let cache = foldEntries(entries).cache
    // Warm: the first refresh pays for building caches and the JIT.
    cache = foldEntries(entries, cache).cache
    const first = cache.items
    const next = [...entries, user('new')]
    const start = performance.now()
    const refreshed = foldEntries(next, cache)
    const took = performance.now() - start
    const replaced = refreshed.items.filter((item, i) => first[i] !== item).length
    expect(refreshed.items).toHaveLength(first.length + 1)
    expect(replaced).toBe(1) // only the new one (the old items are the same objects)
    expect(took).toBeLessThan(50)
  })
})
