/**
 * Reading Claude Code's transcript file for the chat: whole lines only, from
 * where it left off, the tail first and earlier parts on request, sub-agent
 * files, and the report of what no rule placed.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findSubagentTranscript,
  findTranscript,
  readEarlier,
  readSubagent,
  readTranscript,
  resetToldShapes,
  setTranscriptLogger,
} from '../main/claude/transcript'
import { summarise } from '../main/claude/listing'
import { assistant, json, toolResult, toolUse, user } from './transcript-lines'

const id = '26bd97e2-2c61-434c-a607-9fd160970e67'
let dir = ''
let path = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-transcript-'))
  await mkdir(join(dir, 'projects', '-some-vault'), { recursive: true })
  path = join(dir, 'projects', '-some-vault', `${id}.jsonl`)
  resetToldShapes()
})
afterEach(async () => {
  setTranscriptLogger(null)
  await rm(dir, { recursive: true, force: true })
})

/** `count` numbered user lines, each about `pad` bytes. */
const manyLines = (count: number, pad: number): string =>
  Array.from({ length: count }, (_, i) =>
    json(user(`u${i}`, `m${i} ${'x '.repeat(pad / 2)}`)),
  ).join('\n') + '\n'

describe('finding a transcript', () => {
  it('finds a conversation by its id, under whichever project directory', async () => {
    await writeFile(path, '')
    expect(await findTranscript(dir, id)).toBe(path)
    expect(await findTranscript(dir, 'ffffffff-0000')).toBeNull()
    expect(await findTranscript(dir, '../escape')).toBeNull()
  })

  it('finds a sub-agent’s file beside its session, and under a workflow run', async () => {
    const agents = join(dir, 'projects', '-some-vault', id, 'subagents')
    await mkdir(join(agents, 'workflows', 'wf_run1'), { recursive: true })
    await writeFile(join(agents, 'agent-abc123.jsonl'), '')
    await writeFile(join(agents, 'workflows', 'wf_run1', 'agent-def456.jsonl'), '')
    expect(await findSubagentTranscript(dir, id, 'abc123')).toBe(join(agents, 'agent-abc123.jsonl'))
    expect(await findSubagentTranscript(dir, id, 'def456')).toBe(
      join(agents, 'workflows', 'wf_run1', 'agent-def456.jsonl'),
    )
    expect(await findSubagentTranscript(dir, id, 'nope1234')).toBeNull()
  })

  it('refuses an agent id that could name another path', async () => {
    for (const bad of ['../../x', 'a/b', 'abc', '', 'x'.repeat(65), 'with space']) {
      expect(await findSubagentTranscript(dir, id, bad)).toBeNull()
    }
    expect(await findSubagentTranscript(dir, '../s', 'abc123')).toBeNull()
  })
})

describe('reading on from an offset', () => {
  it('reads on from where it left off, leaving a half-written line for later', async () => {
    await writeFile(path, `${json(user('u1', 'one'))}\n${json(user('u2', 'two')).slice(0, 12)}`)
    const first = await readTranscript(path, id)
    expect(first.entries.map((e) => e.id)).toEqual(['u1'])
    expect(first.start).toBe(0)

    await writeFile(path, `${json(user('u1', 'one'))}\n${json(user('u2', 'two'))}\n`)
    await appendFile(path, `${json(assistant('a1', [{ type: 'text', text: 'three' }]))}\n`)
    const next = await readTranscript(path, id, first.offset)
    expect(next.entries.map((e) => e.id)).toEqual(['u2', 'a1:0'])
    expect(next.start).toBeUndefined()
    expect((await readTranscript(path, id, next.offset)).entries).toEqual([])
  })

  it('counts offsets in bytes, not characters', async () => {
    const lines = [json(user('u1', 'blåbærgrød æøå')), json(user('u2', 'tak 🙏'))]
    await writeFile(path, `${lines.join('\n')}\n`)
    const first = await readTranscript(path, id)
    expect(first.offset).toBe(Buffer.byteLength(`${lines.join('\n')}\n`))
    await appendFile(path, `${json(user('u3', 'næste'))}\n`)
    expect((await readTranscript(path, id, first.offset)).entries.map((e) => e.id)).toEqual(['u3'])
  })

  it('starts over when the file is shorter than where it was', async () => {
    await writeFile(path, `${json(user('u1', 'one'))}\n${json(user('u2', 'two'))}\n`)
    const first = await readTranscript(path, id)
    await writeFile(path, `${json(user('n1', 'new'))}\n`)
    expect((await readTranscript(path, id, first.offset)).entries.map((e) => e.id)).toEqual(['n1'])
  })

  it('answers empty for a file that is not there', async () => {
    expect(await readTranscript(join(dir, 'missing.jsonl'), id)).toEqual({
      sessionId: id,
      entries: [],
      offset: 0,
    })
  })

  it('keeps file order when the lines of one message are interleaved with other lines', async () => {
    // Two parallel calls in one API message: the first result arrives before
    // the second call is written.
    const lines = [
      assistant('a1', [toolUse('toolu_a', 'Bash', { command: 'one' })]),
      user('u1', [toolResult('toolu_a', 'first')]),
      assistant('a2', [toolUse('toolu_b', 'Bash', { command: 'two' })]),
      user('u2', [toolResult('toolu_b', 'second')]),
    ]
    await writeFile(path, `${lines.map(json).join('\n')}\n`)
    const { entries } = await readTranscript(path, id)
    expect(entries.map((e) => `${e.kind}:${e.id}`)).toEqual([
      'tool:toolu_a',
      'tool-result:toolu_a',
      'tool:toolu_b',
      'tool-result:toolu_b',
    ])
  })
})

describe('a file rewritten under the reader', () => {
  /** Lines with no uuid: their ids are their byte offsets, the case where a
   *  restart from 0 would collide with what was read before. */
  const bare = (text: string): string =>
    json({ type: 'user', sessionId: 's-1', message: { role: 'user', content: text } })

  it('tells of a rewrite to a shorter file, and reads it from its tail', async () => {
    await writeFile(path, `${bare('old one')}\n${bare('old two')}\n${bare('old three')}\n`)
    const first = await readTranscript(path, id)
    expect(first.fingerprint).toEqual(expect.any(String))
    expect(first.reset).toBeUndefined()
    await writeFile(path, `${bare('new')}\n`)
    const next = await readTranscript(path, id, first.offset, { fingerprint: first.fingerprint })
    expect(next.reset).toBe(true)
    expect(next.entries.map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['new'])
    expect(next.start).toBe(0)
    expect(next.offset).toBe(Buffer.byteLength(`${bare('new')}\n`))
    expect(next.fingerprint).toEqual(expect.any(String))
  })

  it('tells of a rewrite to a longer file, not reading from the middle of a line', async () => {
    await writeFile(path, `${bare('old one')}\n${bare('old two')}\n`)
    const first = await readTranscript(path, id)
    const fresh = Array.from({ length: 6 }, (_, i) => bare(`brand new line ${i}`)).join('\n')
    await writeFile(path, `${fresh}\n`)
    const next = await readTranscript(path, id, first.offset, { fingerprint: first.fingerprint })
    expect(next.reset).toBe(true)
    expect(next.entries.map((e) => e.kind)).toEqual(Array(6).fill('user'))
    expect(next.drift!.unparseable).toBe(0)
  })

  it('tells of a rewrite to a file of the same size', async () => {
    await writeFile(path, `${bare('aaaa')}\n`)
    const first = await readTranscript(path, id)
    await writeFile(path, `${bare('bbbb')}\n`)
    const next = await readTranscript(path, id, first.offset, { fingerprint: first.fingerprint })
    expect(next.reset).toBe(true)
    expect(next.entries.map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['bbbb'])
  })

  it('tells of a shorter file even from a caller with no fingerprint', async () => {
    await writeFile(path, `${bare('old one')}\n${bare('old two')}\n`)
    const first = await readTranscript(path, id)
    await writeFile(path, `${bare('new')}\n`)
    const next = await readTranscript(path, id, first.offset)
    expect(next.reset).toBe(true)
    expect(next.entries).toHaveLength(1)
  })

  it('does not disturb a normal append', async () => {
    await writeFile(path, `${bare('one')}\n`)
    const first = await readTranscript(path, id)
    await appendFile(path, `${bare('two')}\n`)
    const next = await readTranscript(path, id, first.offset, { fingerprint: first.fingerprint })
    expect(next.reset).toBeUndefined()
    expect(next.entries.map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['two'])
    await appendFile(path, `${bare('three')}\n`)
    const last = await readTranscript(path, id, next.offset, { fingerprint: next.fingerprint })
    expect(last.reset).toBeUndefined()
    expect(last.entries).toHaveLength(1)
  })

  it('does not disturb a read at the end of an unchanged file', async () => {
    await writeFile(path, `${bare('one')}\n`)
    const first = await readTranscript(path, id)
    const again = await readTranscript(path, id, first.offset, { fingerprint: first.fingerprint })
    expect(again).toMatchObject({
      entries: [],
      offset: first.offset,
      fingerprint: first.fingerprint,
    })
    expect(again.reset).toBeUndefined()
  })

  it('does not disturb a half-written last line', async () => {
    await writeFile(path, `${bare('one')}\n`)
    const first = await readTranscript(path, id)
    const half = bare('two')
    await appendFile(path, half.slice(0, 20))
    const mid = await readTranscript(path, id, first.offset, { fingerprint: first.fingerprint })
    expect(mid.reset).toBeUndefined()
    expect(mid.entries).toEqual([])
    expect(mid.offset).toBe(first.offset)
    await appendFile(path, `${half.slice(20)}\n`)
    const done = await readTranscript(path, id, mid.offset, { fingerprint: mid.fingerprint })
    expect(done.reset).toBeUndefined()
    expect(done.entries.map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['two'])
  })

  it('does not throw on an offset that is not a whole number', async () => {
    await writeFile(path, `${bare('one')}\n`)
    for (const offset of [Number.NaN, 1.5, -3, Number.POSITIVE_INFINITY, 2 ** 60]) {
      const read = await readTranscript(path, id, offset)
      expect(read.reset).toBe(true)
      expect(read.entries).toHaveLength(1)
    }
  })
})

describe('the first read and earlier parts', () => {
  it('takes the tail from a line start, and says where it began', async () => {
    const text = manyLines(400, 6000)
    await writeFile(path, text)
    const first = await readTranscript(path, id)
    const start = first.start!
    expect(start).toBeGreaterThan(0)
    expect(text[start - 1]).toBe('\n')
    expect(first.offset).toBe(Buffer.byteLength(text))
    expect(first.entries.every((e) => e.kind === 'user')).toBe(true)
    expect(first.entries.at(-1)!.id).toBe('u399')
    expect(first.drift).toEqual({
      lines: first.entries.length,
      unknown: [],
      oversize: 0,
      unparseable: 0,
    })
  })

  it('reads backwards without gap or overlap, to the start of the file', async () => {
    const text = manyLines(400, 6000)
    await writeFile(path, text)
    const first = await readTranscript(path, id)
    let ids = first.entries.map((e) => e.id)
    let start = first.start!
    for (let guard = 0; start > 0 && guard < 20; guard += 1) {
      const earlier = await readEarlier(path, id, start)
      expect(earlier.start).toBeLessThan(start)
      expect(text[earlier.start - 1] ?? '\n').toBe('\n')
      ids = [...earlier.entries.map((e) => e.id), ...ids]
      start = earlier.start
    }
    expect(start).toBe(0)
    expect(ids).toEqual(Array.from({ length: 400 }, (_, i) => `u${i}`))
  })

  it('answers nothing earlier at the start of the file, or for a missing file', async () => {
    await writeFile(path, `${json(user('u1', 'one'))}\n`)
    expect(await readEarlier(path, id, 0)).toEqual({ entries: [], start: 0 })
    expect(await readEarlier(join(dir, 'missing.jsonl'), id, 100)).toEqual({
      entries: [],
      start: 0,
    })
    const small = await readEarlier(path, id, 9999)
    expect(small.start).toBe(0)
    expect(small.entries.map((e) => e.id)).toEqual(['u1'])
  })
})

describe('what is wrong with a line costs that line only', () => {
  it('shows a line over 4 MB as a placeholder and reads on', async () => {
    const big = json(user('big', 'x '.repeat(2_200_000)))
    expect(big.length).toBeGreaterThan(4 * 1024 * 1024)
    await writeFile(path, `${json(user('u1', 'before'))}\n${big}\n${json(user('u2', 'after'))}\n`)
    const read = await readTranscript(path, id, 0)
    expect(read.entries.map((e) => e.kind)).toEqual(['user', 'unknown', 'user'])
    expect(read.entries[1]).toMatchObject({ shape: 'oversize' })
    expect(read.entries[1]!.id).toMatch(/^L\d+$/)
    expect(read.drift).toMatchObject({ lines: 3, oversize: 1, unparseable: 0 })
  })

  it('shows a line that is not JSON as an unknown row', async () => {
    await writeFile(path, `${json(user('u1', 'a'))}\n{"broken":\n${json(user('u2', 'b'))}\n`)
    const read = await readTranscript(path, id, 0)
    expect(read.entries.map((e) => e.kind)).toEqual(['user', 'unknown', 'user'])
    expect(read.drift).toMatchObject({ unparseable: 1, unknown: [] })
  })

  it('names a line with no uuid by where it is, the same on every read', async () => {
    const first = json(user('u1', 'a'))
    await writeFile(path, `${first}\n${json({ type: 'user', message: { content: 'anon' } })}\n`)
    const a = await readTranscript(path, id, 0)
    const b = await readTranscript(path, id)
    const anon = (r: typeof a) => r.entries.find((e) => e.kind === 'user' && e.text === 'anon')!.id
    expect(anon(a)).toBe(`L${Buffer.byteLength(first) + 1}`)
    expect(anon(b)).toBe(anon(a))
  })

  it('counts hidden unknown shapes in the drift report, by signature', async () => {
    const lines = [
      { type: 'brand-new-type' },
      { type: 'brand-new-type' },
      { type: 'attachment', attachment: { type: 'fresh_attachment' } },
      { type: 'system', subtype: 'fresh_subtype' },
      { type: 'mode' },
      user('u1', 'ok'),
    ]
    await writeFile(path, `${lines.map(json).join('\n')}\n`)
    const read = await readTranscript(path, id)
    expect(read.drift!.lines).toBe(6)
    expect(read.drift!.unknown).toEqual(
      expect.arrayContaining([
        { shape: 'brand-new-type', count: 2 },
        { shape: 'attachment|fresh_attachment', count: 1 },
        { shape: 'system|fresh_subtype', count: 1 },
      ]),
    )
    expect(read.drift!.unknown).toHaveLength(3)
    // Hidden, counted: only the system one is drawn.
    expect(read.entries.map((e) => e.kind)).toEqual(['unknown', 'user'])
  })

  it('tells the logger once per shape, with the shape and a count and no content', async () => {
    const told: string[] = []
    setTranscriptLogger((m) => told.push(m))
    const secret = 'SECRET-CONTENT'
    const line = json({ type: 'brand-new-type', note: secret })
    await writeFile(path, `${line}\n${line}\n`)
    await readTranscript(path, id)
    await appendFile(path, `${line}\n`)
    await readTranscript(path, id)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('brand-new-type')
    expect(told[0]).toContain('2 lines')
    expect(told[0]).not.toContain(secret)
  })

  it('survives a logger that throws', async () => {
    setTranscriptLogger(() => {
      throw new Error('log broke')
    })
    await writeFile(path, `${json({ type: 'another-new-type' })}\n${json(user('u1', 'ok'))}\n`)
    expect((await readTranscript(path, id)).entries.map((e) => e.id)).toEqual(['u1'])
  })
})

describe('a sub-agent’s conversation', () => {
  it('reads its lines as its own, and on from an offset', async () => {
    const agents = join(dir, 'projects', '-some-vault', id, 'subagents')
    await mkdir(agents, { recursive: true })
    const file = join(agents, 'agent-abc123.jsonl')
    const inner = (uuid: string, text: string) =>
      assistant(uuid, [{ type: 'text', text }], { isSidechain: true, agentId: 'abc123' })
    await writeFile(file, `${json(inner('s1', 'working'))}\n`)

    const first = (await readSubagent(dir, id, 'abc123'))!
    expect(first.entries).toEqual([{ kind: 'assistant', id: 's1:0', text: 'working' }])
    expect(first.start).toBe(0)

    await appendFile(file, `${json(inner('s2', 'done'))}\n`)
    const next = (await readSubagent(dir, id, 'abc123', first.offset))!
    expect(next.entries.map((e) => e.id)).toEqual(['s2:0'])
  })

  it('takes the tail of a big file on its first read, and says where it began', async () => {
    const agents = join(dir, 'projects', '-some-vault', id, 'subagents')
    await mkdir(agents, { recursive: true })
    const file = join(agents, 'agent-abc123.jsonl')
    const pad = 'x '.repeat(512)
    const lines = Array.from({ length: 5000 }, (_, i) =>
      json(assistant(`s${i}`, [{ type: 'text', text: pad }], { isSidechain: true })),
    )
    await writeFile(file, `${lines.join('\n')}\n`)
    const first = (await readSubagent(dir, id, 'abc123'))!
    expect(first.start).toBeGreaterThan(0)
    expect(first.entries.length).toBeLessThan(5000)
    expect(first.entries.at(-1)!.id).toBe('s4999:0')
    expect(first.fingerprint).toEqual(expect.any(String))
    const next = (await readSubagent(dir, id, 'abc123', first.offset, first.fingerprint))!
    expect(next.entries).toEqual([])
    expect(next.reset).toBeUndefined()
  })

  it('does not follow a symlink out of the sub-agent directory', async () => {
    const agents = join(dir, 'projects', '-some-vault', id, 'subagents')
    await mkdir(agents, { recursive: true })
    const outside = join(dir, 'secret.jsonl')
    await writeFile(outside, `${json(user('u1', 'not yours'))}\n`)
    await symlink(outside, join(agents, 'agent-abc123.jsonl'))
    expect(await findSubagentTranscript(dir, id, 'abc123')).toBeNull()
    expect(await readSubagent(dir, id, 'abc123')).toBeNull()
  })

  it('does not follow a symlinked directory out of the session', async () => {
    const elsewhere = join(dir, 'elsewhere')
    await mkdir(join(elsewhere, 'subagents'), { recursive: true })
    await writeFile(
      join(elsewhere, 'subagents', 'agent-abc123.jsonl'),
      `${json(user('u1', 'not yours'))}\n`,
    )
    await symlink(elsewhere, join(dir, 'projects', '-some-vault', id))
    expect(await findSubagentTranscript(dir, id, 'abc123')).toBeNull()
  })

  it('answers null when there is no such file or the id is bad', async () => {
    expect(await readSubagent(dir, id, 'abc123')).toBeNull()
    expect(await readSubagent(dir, id, '../../etc')).toBeNull()
  })
})

describe('an idle session', () => {
  const row = { id: 'j1', name: 'n', pid: 1, status: 'idle' as const }
  it('says what it has behind it', () => {
    expect(summarise({ ...row, state: 'done' }, new Set()).phase).toBe('done')
    expect(summarise({ ...row, state: 'failed' }, new Set()).phase).toBe('failed')
    expect(summarise({ ...row, state: 'blocked' }, new Set()).phase).toBe('new')
  })
  it('has no phase while it works', () => {
    expect(summarise({ ...row, status: 'busy', state: 'working' }, new Set()).phase).toBeUndefined()
  })
})
