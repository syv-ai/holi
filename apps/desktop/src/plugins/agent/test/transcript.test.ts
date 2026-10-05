/**
 * Claude Code's transcript as the chat reads it: only the shapes it knows,
 * whole lines only, and from where it left off.
 */
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findTranscript, parseTranscriptLine, readTranscript } from '../main/claude/transcript'
import { summarise } from '../main/claude/listing'

const line = (value: unknown): string => JSON.stringify(value)
const user = (uuid: string, content: unknown) => ({ type: 'user', uuid, message: { content } })
const assistant = (uuid: string, content: unknown) => ({
  type: 'assistant',
  uuid,
  message: { content },
})

describe('parseTranscriptLine', () => {
  it('reads a message the person typed', () => {
    expect(parseTranscriptLine(line(user('u1', 'hello')))).toEqual([
      { kind: 'user', id: 'u1', text: 'hello' },
    ])
  })

  it('drops what Claude Code wrapped around or injected into a prompt', () => {
    expect(
      parseTranscriptLine(line(user('u1', '<system-reminder>x</system-reminder>do it'))),
    ).toEqual([{ kind: 'user', id: 'u1', text: 'do it' }])
    expect(parseTranscriptLine(line(user('u2', '<command-name>/clear</command-name>')))).toEqual([])
    expect(parseTranscriptLine(line({ ...user('u3', 'meta'), isMeta: true }))).toEqual([])
    expect(parseTranscriptLine(line({ ...assistant('a0', []), isSidechain: true }))).toEqual([])
  })

  it('reads text and tool calls, and skips thinking', () => {
    const entries = parseTranscriptLine(
      line(
        assistant('a1', [
          { type: 'thinking', thinking: 'hm' },
          { type: 'text', text: 'Reading it.' },
          { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'notes/a.md' } },
        ]),
      ),
    )
    expect(entries).toEqual([
      { kind: 'assistant', id: 'a1:1', text: 'Reading it.' },
      expect.objectContaining({ kind: 'tool', id: 'call-1', name: 'Read', summary: 'notes/a.md' }),
    ])
  })

  it('reads a tool result, and whether it failed', () => {
    const entries = parseTranscriptLine(
      line(
        user('u4', [
          { type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'no such file' },
        ]),
      ),
    )
    expect(entries).toEqual([
      { kind: 'tool-result', id: 'call-1', ok: false, text: 'no such file' },
    ])
  })

  it('answers nothing for a line it does not know', () => {
    expect(parseTranscriptLine('not json')).toEqual([])
    expect(parseTranscriptLine(line({ type: 'mode', mode: 'normal' }))).toEqual([])
  })
})

describe('readTranscript', () => {
  const id = '26bd97e2-2c61-434c-a607-9fd160970e67'
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'holi-transcript-'))
    await mkdir(join(dir, 'projects', '-some-vault'), { recursive: true })
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('finds a conversation by its id, under whichever project directory', async () => {
    const path = join(dir, 'projects', '-some-vault', `${id}.jsonl`)
    await writeFile(path, '')
    expect(await findTranscript(dir, id)).toBe(path)
    expect(await findTranscript(dir, 'ffffffff-0000')).toBeNull()
    expect(await findTranscript(dir, '../escape')).toBeNull()
  })

  it('reads on from where it left off, leaving a half-written line for later', async () => {
    const path = join(dir, 'projects', '-some-vault', `${id}.jsonl`)
    await writeFile(path, `${line(user('u1', 'one'))}\n${line(user('u2', 'two')).slice(0, 12)}`)
    const first = await readTranscript(path, id)
    expect(first.entries.map((e) => e.id)).toEqual(['u1'])

    await writeFile(path, `${line(user('u1', 'one'))}\n${line(user('u2', 'two'))}\n`)
    await appendFile(path, `${line(assistant('a1', [{ type: 'text', text: 'three' }]))}\n`)
    const next = await readTranscript(path, id, first.offset)
    expect(next.entries.map((e) => e.id)).toEqual(['u2', 'a1:0'])
    expect((await readTranscript(path, id, next.offset)).entries).toEqual([])
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
