import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  claudeChatArgs,
  newClaudeReader,
  permissionResult,
  readClaudeRecord,
  type JsonRecord,
} from '../main/claude-stream'
import { createChats } from '../main/chats'
import { applyChatEvent, transcriptNow, type ChatEvent, type TranscriptItem } from '../shared/chat'

const ROOT = '/v'

/** Records as Claude Code 2.1 prints them (trimmed from a real run). */
const RUN: JsonRecord[] = [
  { type: 'system', subtype: 'init', session_id: 'conv-1', cwd: ROOT },
  {
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'm1' } },
    session_id: 'conv-1',
  },
  {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} },
    },
  },
  {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"file_path":"/v/hello.md","content":"hi"}',
      },
    },
  },
  {
    type: 'control_request',
    request_id: 'req-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      input: { file_path: '/v/hello.md', content: 'hi' },
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      tool_use_id: 't1',
    },
  },
]

function run(records: JsonRecord[]): {
  items: TranscriptItem[]
  reader: ReturnType<typeof newClaudeReader>
  results: ReturnType<typeof readClaudeRecord>[]
} {
  const reader = newClaudeReader()
  let items: TranscriptItem[] = []
  const results = records.map((r) => {
    const res = readClaudeRecord(reader, r)
    for (const e of res.events) items = applyChatEvent(items, e, ROOT).items
    return res
  })
  return { items, reader, results }
}

describe('Claude Code stream-json', () => {
  it('never launches a mode that skips permissions', () => {
    const args = claudeChatArgs({ mode: 'default', sessionId: 'abc' })
    expect(args).toContain('--permission-prompt-tool')
    expect(args.join(' ')).not.toMatch(/dangerously|bypass|allowedTools/)
    expect(args.slice(-2)).toEqual(['--session-id', 'abc'])
    expect(claudeChatArgs({ mode: 'plan', resume: 'x' }).slice(-2)).toEqual(['--resume', 'x'])
  })

  it('turns a can_use_tool request into an inline card, with the tool row beside it', () => {
    const { items, results } = run(RUN)
    expect(results[0]!.sessionId).toBe('conv-1')
    const tool = items.find((i) => i.kind === 'tool')
    expect(tool).toMatchObject({
      title: 'Wrote',
      active: 'Writing',
      subject: 'hello.md',
      status: 'running',
    })
    const card = items.find((i) => i.kind === 'approval')
    expect(card).toMatchObject({
      verb: 'Write',
      subject: 'hello.md',
      status: 'pending',
      canAlways: true,
    })
    expect(transcriptNow(items).waitingFor).toBe('Write hello.md?')
    expect(results[4]!.permission?.requestId).toBe('req-1')
  })

  it("answers with Claude Code's own suggestion for Always allow", () => {
    const { results } = run(RUN)
    const pending = results[4]!.permission!
    expect(permissionResult(pending, { kind: 'allow', always: true })).toEqual({
      behavior: 'allow',
      updatedInput: pending.input,
      updatedPermissions: pending.suggestions,
    })
    expect(permissionResult(pending, { kind: 'allow' })).not.toHaveProperty('updatedPermissions')
    expect(permissionResult(pending, { kind: 'deny' })).toMatchObject({ behavior: 'deny' })
  })

  it('streams text, settles tools and reads the turn end and context', () => {
    const { items, results } = run([
      ...RUN,
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File created' }] },
      },
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Done' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '.' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      // The whole message again: already streamed, so not drawn twice.
      {
        type: 'assistant',
        message: {
          id: 'm2',
          content: [{ type: 'text', text: 'Done.' }],
          usage: { input_tokens: 10 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        usage: { iterations: [{ input_tokens: 40_000, output_tokens: 10_000 }] },
        modelUsage: { m: { contextWindow: 200_000 } },
      },
    ])
    expect(items.filter((i) => i.kind === 'assistant')).toEqual([
      expect.objectContaining({ text: 'Done.', streaming: false }),
    ])
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({
      status: 'done',
      detail: 'File created',
    })
    const end = results.at(-1)!
    expect(end.turnEnded).toMatchObject({ failed: false })
    expect(end.contextPercent).toBe(25)
  })

  it('leaves subagents out of the main transcript', () => {
    const { items } = run([
      {
        type: 'assistant',
        parent_tool_use_id: 'task-1',
        message: { id: 'x', content: [{ type: 'text', text: 'sub' }] },
      },
    ])
    expect(items).toEqual([])
  })
})

/** A Claude Code process that prints what the test tells it to. */
function fakeProcess() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: () => {
      child.emit('exit', null)
      return true
    },
  })
  const written: string[] = []
  stdin.on('data', (d: Buffer) => written.push(...String(d).split('\n').filter(Boolean)))
  const print = (r: JsonRecord) => stdout.write(`${JSON.stringify(r)}\n`)
  return { child, written, print }
}

const tick = () => new Promise((r) => setTimeout(r, 30))

describe('chat sessions', () => {
  it('brackets a turn, holds a permission for the person and answers it', async () => {
    const proc = fakeProcess()
    const turns: string[] = []
    const events: { name: string; payload: unknown }[] = []
    const chats = createChats({
      userData: await mkdtemp(join(tmpdir(), 'holi-chats-')),
      emit: (_r, name, payload) => events.push({ name, payload }),
      target: async () => ({ root: ROOT, env: {}, claude: '/bin/claude' }),
      turn: (id, active) => turns.push(`${active ? 'begin' : 'end'}:${id}`),
      gone: (id) => turns.push(`gone:${id}`),
      spawnProcess: () => proc.child as unknown as ChildProcessWithoutNullStreams,
    })
    await chats.attach('o/r')
    const started = await chats.start({ text: 'Write hello', id: 'c1' })
    expect(started).toEqual({ ok: true, id: 'c1' })
    expect(JSON.parse(proc.written[0]!)).toMatchObject({
      type: 'user',
      message: { content: [{ text: 'Write hello' }] },
    })
    expect(turns).toEqual(['begin:c1'])

    for (const r of RUN) proc.print(r)
    await tick()
    expect(chats.list()[0]).toMatchObject({
      id: 'c1',
      state: 'needs-you',
      waitingFor: 'Write hello.md?',
    })

    await chats.answer('c1', 'req-1', { kind: 'allow' })
    expect(JSON.parse(proc.written.at(-1)!)).toMatchObject({
      type: 'control_response',
      response: { request_id: 'req-1', response: { behavior: 'allow' } },
    })
    expect(chats.list()[0]!.state).toBe('working')

    proc.print({ type: 'result', subtype: 'success' })
    await tick()
    expect(turns).toEqual(['begin:c1', 'end:c1'])
    expect(chats.list()[0]).toMatchObject({ state: 'idle', reviewed: false, alive: true })
    const transcript = await chats.transcript('c1')
    expect(transcript.map((i) => i.kind)).toEqual(['user', 'turn', 'tool', 'approval'])
    expect(transcript.find((i) => i.kind === 'turn')).toHaveProperty('endedAt')
    await chats.leave()
  })

  it('reports a process that dies mid-turn', async () => {
    const proc = fakeProcess()
    const turns: string[] = []
    const chats = createChats({
      userData: await mkdtemp(join(tmpdir(), 'holi-chats-')),
      emit: () => {},
      target: async () => ({ root: ROOT, env: {}, claude: '/bin/claude' }),
      turn: (id, active) => turns.push(`${active ? 'begin' : 'end'}:${id}`),
      gone: (id) => turns.push(`gone:${id}`),
      spawnProcess: () => proc.child as unknown as ChildProcessWithoutNullStreams,
    })
    await chats.attach('o/r')
    await chats.start({ text: 'go', id: 'c2' })
    proc.child.emit('exit', 1)
    await tick()
    expect(turns).toEqual(['begin:c2', 'gone:c2'])
    const t = await chats.transcript('c2')
    expect(t.some((i) => i.kind === 'error')).toBe(true)
    await chats.leave()
  })

  it('says so when Claude Code is not installed', async () => {
    const chats = createChats({
      userData: await mkdtemp(join(tmpdir(), 'holi-chats-')),
      emit: () => {},
      target: async () => ({ root: ROOT, env: {}, claude: null }),
      turn: () => {},
      gone: () => {},
    })
    await chats.attach('o/r')
    const res = await chats.start({ text: 'go' })
    expect(res).toMatchObject({
      ok: false,
      message: expect.stringContaining('Claude Code is not installed'),
    })
  })
})

describe('the reducer', () => {
  it('closes what was in flight when a turn ends', () => {
    const events: ChatEvent[] = [
      { type: 'user', id: 'u', text: 'x', at: 1 },
      { type: 'turn-start', id: 't', at: 1 },
      { type: 'text', delta: 'par' },
      { type: 'tool-start', callId: 'c', name: 'Bash', input: { command: 'ls -la' } },
      { type: 'turn-end', at: 7000 },
    ]
    let items: TranscriptItem[] = []
    for (const e of events) items = applyChatEvent(items, e).items
    expect(items.map((i) => i.kind)).toEqual(['user', 'turn', 'assistant', 'tool'])
    expect(items[2]).toMatchObject({ streaming: false })
    expect(items[3]).toMatchObject({ status: 'done', subject: 'ls -la' })
    expect(items[1]).toMatchObject({ endedAt: 7000 })
  })
})
