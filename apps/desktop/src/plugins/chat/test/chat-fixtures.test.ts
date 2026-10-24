/**
 * Captured Claude Code runs, fixture in, transcript items out: what each tool
 * step opens into, the diffs, the todo list, plan mode, subagents, thinking,
 * and the other events (see `replay.ts` for where the fixtures came from).
 */
import { describe, expect, it } from 'vitest'
import {
  newClaudeReader,
  permissionResult,
  readClaudeRecord,
  userMessage,
} from '../main/claude-stream'
import { applyChatEvent, type TranscriptItem } from '../shared/chat'
import { diffLines } from '../shared/tool-views'
import { foldConversation, isConversationId, projectSlug } from '../main/conversation'
import { fixtureLines, ofKind, replay } from './replay'

type Tool = Extract<TranscriptItem, { kind: 'tool' }>

const tool = (items: TranscriptItem[], pred: (t: Tool) => boolean): Tool => {
  const t = ofKind(items, 'tool').find(pred)
  if (t === undefined) throw new Error('no such tool step')
  return t
}

describe('tool steps open into their results', () => {
  const { items } = replay('tools')

  it('a command: its output and exit status', () => {
    const ok = tool(items, (t) => t.view?.type === 'shell' && t.view.command === 'ls -la')
    expect(ok.status).toBe('done')
    expect(ok.view).toMatchObject({ type: 'shell', exitCode: 0 })
    expect(ok.view?.type === 'shell' && ok.view.stdout).toContain('calc.py')

    const bad = tool(items, (t) => t.view?.type === 'shell' && t.view.command.startsWith('cat '))
    expect(bad.status).toBe('failed')
    expect(bad.view).toMatchObject({
      type: 'shell',
      exitCode: 1,
      stderr: 'cat: does-not-exist.txt: No such file or directory',
    })
  })

  it('a read: the lines, numbered from where it started', () => {
    const read = tool(items, (t) => t.tool === 'Read')
    expect(read.subject).toBe('notes.md')
    expect(read.view).toMatchObject({
      type: 'read',
      path: 'notes.md',
      startLine: 1,
      totalLines: 11,
    })
    expect(read.view?.type === 'read' && read.view.lines[3]).toBe('Beta line')
  })

  it("an edit: Claude Code's own hunks, with line numbers", () => {
    const edit = tool(items, (t) => t.tool === 'Edit')
    expect(edit.view?.type).toBe('diff')
    const file = edit.view?.type === 'diff' ? edit.view.files[0]! : null
    expect(file).toMatchObject({ path: 'notes.md', added: 1, removed: 1 })
    expect(file?.lines).toContainEqual({ kind: 'del', text: 'Beta line', old: 4 })
    expect(file?.lines).toContainEqual({ kind: 'add', text: 'Beta line (edited)', new: 4 })
  })

  it('a new file: every line added', () => {
    const write = tool(items, (t) => t.tool === 'Write')
    expect(write.view).toEqual({
      type: 'diff',
      files: [
        {
          path: 'hello.txt',
          created: true,
          added: 2,
          removed: 0,
          lines: [
            { kind: 'add', text: 'hello', new: 1 },
            { kind: 'add', text: 'world', new: 2 },
          ],
        },
      ],
    })
  })

  it('an approval names the call it asks about', () => {
    const approval = ofKind(items, 'approval').find((a) => a.tool === 'Edit')!
    expect(approval.callId).toBe(tool(items, (t) => t.tool === 'Edit').id)
    expect(approval.status).toBe('allowed')
  })

  it('times thinking that Claude Code keeps to itself', () => {
    const thoughts = ofKind(items, 'reasoning')
    expect(thoughts.length).toBeGreaterThan(0)
    for (const r of thoughts) {
      expect(r.text).toBe('')
      expect(r.streaming).toBe(false)
      expect(r.endedAt! - r.startedAt!).toBeGreaterThan(0)
    }
  })

  it('reports the session info from init', () => {
    const { info } = replay('tools')
    expect(info[0]?.tools).toContain('mcp__weather__get_forecast')
    expect(info[0]?.mcpServers).toEqual([{ name: 'weather', status: 'connected' }])
    expect(info[0]?.version).toBe('2.1.310')
  })
})

describe('more edits', () => {
  it('a notebook cell: old source to new', () => {
    const { items } = replay('multiedit')
    const nb = tool(items, (t) => t.tool === 'NotebookEdit')
    expect(nb.view?.type === 'diff' && nb.view.files[0]).toMatchObject({
      path: 'nb.ipynb',
      lines: [
        { kind: 'del', text: 'print(1)' },
        { kind: 'add', text: 'print(2)' },
      ],
    })
  })

  it('MultiEdit: one diff over its hunks', () => {
    const { items } = replay('synth-search')
    const me = tool(items, (t) => t.tool === 'MultiEdit')
    const file = me.view?.type === 'diff' ? me.view.files[0]! : null
    expect(file).toMatchObject({ added: 2, removed: 2 })
    expect(file?.lines.some((l) => l.kind === 'gap')).toBe(true)
    expect(file?.lines).toContainEqual({ kind: 'add', text: 'def minus(a, b):', new: 5 })
  })

  it('a diff from the input alone keeps its order', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { kind: 'ctx', text: 'a', old: 1, new: 1 },
      { kind: 'del', text: 'b', old: 2 },
      { kind: 'add', text: 'B', new: 2 },
      { kind: 'ctx', text: 'c', old: 3, new: 3 },
    ])
  })
})

describe('searches, the web and MCP', () => {
  it('Glob and Grep: vault paths, lines where there are', () => {
    const { items } = replay('synth-search')
    expect(tool(items, (t) => t.tool === 'Glob').view).toEqual({
      type: 'paths',
      pattern: '**/*.md',
      matches: [{ path: 'notes.md' }, { path: 'Meetings/Week kickoff.md' }],
      total: 2,
    })
    const grep = tool(items, (t) => t.id === 'grep1')
    expect(grep.view?.type === 'paths' && grep.view.matches[1]).toEqual({
      path: 'calc.py',
      line: 5,
      text: 'def sub(a, b):',
    })
  })

  it('WebFetch and WebSearch: the URL or query, the status and the answer', () => {
    const { items } = replay('web')
    expect(tool(items, (t) => t.tool === 'WebFetch').view).toMatchObject({
      type: 'web',
      url: 'https://example.com',
      status: '200 OK',
      summary: 'The title of this page is "Example Domain."',
    })
    const search = tool(items, (t) => t.tool === 'WebSearch')
    expect(search.view).toMatchObject({ type: 'web', query: 'example.com domain IANA' })
    expect(search.view?.type === 'web' && search.view.links?.length).toBeGreaterThan(0)
  })

  it('an MCP tool: its server, its tool and the JSON it returned', () => {
    const { items } = replay('mcp')
    const call = tool(items, (t) => t.toolKind === 'mcp')
    expect(call).toMatchObject({ title: 'Used get forecast from', subject: 'weather' })
    expect(call.view).toMatchObject({ type: 'mcp', server: 'weather', tool: 'get_forecast' })
    const result = call.view?.type === 'mcp' ? call.view.result : ''
    expect(JSON.parse(result ?? '')).toMatchObject({ city: 'Copenhagen' })
    expect(result).toContain('\n  ')
  })
})

describe('the todo list', () => {
  it('is one card per turn, updated in place', () => {
    const { items } = replay('synth-todos')
    const lists = ofKind(items, 'todos')
    expect(lists).toHaveLength(1)
    expect(lists[0]!.todos.map((t) => t.status)).toEqual(['completed', 'completed', 'completed'])
    expect(ofKind(items, 'tool')).toHaveLength(0)
  })

  it('keeps each version as it lands', () => {
    const { events } = replay('synth-todos')
    let items: TranscriptItem[] = []
    const seen: string[][] = []
    for (const e of events) {
      items = applyChatEvent(items, e, '/vault').items
      const list = ofKind(items, 'todos')[0]
      if (list !== undefined) seen.push(list.todos.map((t) => t.status))
    }
    expect(seen).toContainEqual(['completed', 'in_progress', 'pending'])
  })
})

describe('plan mode', () => {
  it("ExitPlanMode is a plan card that Claude Code's prompt approves", () => {
    const { items, modes } = replay('plan')
    const plan = ofKind(items, 'plan')
    expect(plan).toHaveLength(1)
    expect(plan[0]!.plan).toContain('# Plan: add `divide` to calc.py')
    expect(plan[0]!.status).toBe('approved')
    expect(plan[0]!.requestId).toBeDefined()
    expect(ofKind(items, 'approval').some((a) => a.tool === 'ExitPlanMode')).toBe(false)
    expect(ofKind(items, 'status').map((s) => s.text)).toContain('Exited plan mode')
    expect(modes).toEqual(['plan', 'default'])
  })

  it('entering and leaving are status steps, from the mode Claude Code reports', () => {
    const { items } = replay('enterplan')
    const said = ofKind(items, 'status').map((s) => s.text)
    expect(said).toEqual(['Entered plan mode', 'Exited plan mode'])
    expect(ofKind(items, 'tool').some((t) => t.tool === 'EnterPlanMode')).toBe(false)
  })

  it('Approve with edits accepted takes only the mode switch Claude Code offered', () => {
    const pending = {
      requestId: 'r',
      toolName: 'ExitPlanMode',
      input: { plan: 'p' },
      suggestions: [
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        { type: 'addRules', rules: [] },
      ],
    }
    expect(permissionResult(pending, { kind: 'allow', mode: 'acceptEdits' })).toEqual({
      behavior: 'allow',
      updatedInput: { plan: 'p' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
    expect(permissionResult(pending, { kind: 'deny', message: 'Add tests first' })).toEqual({
      behavior: 'deny',
      message: 'Add tests first',
    })
  })
})

describe('subagents', () => {
  it("a subagent's steps hang under its call, with its answer", () => {
    const { items } = replay('agent')
    const agent = tool(items, (t) => t.tool === 'Agent')
    expect(agent).toMatchObject({ toolKind: 'agent', title: 'List function names in calc.py' })
    expect(agent.view).toMatchObject({
      type: 'agent',
      agentType: 'general-purpose',
      result: 'add, sub, mul',
      toolCount: 2,
    })
    const inner = ofKind(items, 'tool').filter((t) => t.parentId === agent.id)
    expect(inner.map((t) => t.tool)).toEqual(['Bash', 'Read'])
    // Its prose is not the agent's: only the main reply is.
    expect(ofKind(items, 'assistant').map((a) => a.text)).toEqual([
      'calc.py defines three functions: add, sub, mul.',
    ])
  })
})

describe('other events', () => {
  it('compaction', () => {
    const { items } = replay('thinking')
    expect(ofKind(items, 'status')).toMatchObject([
      { text: 'Context compacted', icon: 'compact', detail: '20k → 3.2k tokens' },
    ])
  })

  it('a refused call is denied, with the reason', () => {
    const { items } = replay('deny')
    expect(tool(items, (t) => t.tool === 'Write')).toMatchObject({
      status: 'denied',
      detail: 'The person declined this.',
    })
    const hooked = replay('hooks').items
    const blocked = tool(hooked, (t) => t.tool === 'Bash')
    expect(blocked.status).toBe('denied')
    expect(blocked.view?.type === 'shell' && blocked.view.stderr).toContain('no rm here')
    expect(ofKind(hooked, 'status')).toMatchObject([
      { text: 'PostToolUse:Read says: Read was logged', icon: 'hook' },
    ])
  })

  it('a stopped turn says Stopped, not failed', () => {
    const { items } = replay('interrupt')
    const turn = ofKind(items, 'turn')[0]!
    expect(turn.interrupted).toBe(true)
    expect(turn.failed).toBeUndefined()
    expect(ofKind(items, 'status').map((s) => s.text)).toEqual(['Stopped'])
    expect(ofKind(items, 'error')).toHaveLength(0)
    expect(tool(items, (t) => t.tool === 'Bash').detail).toBe('Stopped before it finished.')
  })

  it('thinking text, retries, the usage limit and a command’s output', () => {
    const { items } = replay('synth-events')
    expect(ofKind(items, 'reasoning')).toMatchObject([
      { text: 'The person wants the sum. 17 + 25 is 42.', streaming: false },
    ])
    expect(ofKind(items, 'status')).toMatchObject([
      { icon: 'retry', tone: 'warning', detail: '529 overloaded_error' },
      { icon: 'limit' },
    ])
    expect(ofKind(items, 'assistant').map((a) => a.text)).toEqual(['42', 'Total cost: $0.01'])
  })

  it('an unknown tool keeps its raw input and output', () => {
    const reader = newClaudeReader(() => 1)
    let items: TranscriptItem[] = []
    for (const r of [
      {
        type: 'assistant',
        message: {
          id: 'm',
          content: [{ type: 'tool_use', id: 'x1', name: 'Frobnicate', input: { level: 3 } }],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'frobbed' }] },
      },
    ]) {
      for (const e of readClaudeRecord(reader, r).events) items = applyChatEvent(items, e).items
    }
    expect(tool(items, () => true)).toMatchObject({
      title: 'Used frobnicate',
      view: { type: 'raw', input: '{\n  "level": 3\n}', output: 'frobbed' },
    })
  })
})

describe('attachments', () => {
  it('sends images as image blocks and files as text, before the message', () => {
    const line = JSON.parse(
      userMessage('What is this?', [
        { name: 'red.png', mediaType: 'image/png', data: 'iVBORw0K' },
        { name: 'notes.txt', mediaType: 'text/plain', data: Buffer.from('hi').toString('base64') },
      ]),
    )
    expect(line.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } },
      { type: 'text', text: '<file name="notes.txt">\nhi\n</file>' },
      { type: 'text', text: 'What is this?' },
    ])
  })
})

describe('transcripts saved before these fields', () => {
  it('still fold events', () => {
    const old: TranscriptItem[] = [
      { kind: 'user', id: 'u', text: 'hi', at: 1 },
      { kind: 'turn', id: 't', startedAt: 1 },
      {
        kind: 'tool',
        id: 'c',
        tool: 'Bash',
        toolKind: 'execute',
        title: 'Ran',
        active: 'Running',
        status: 'running',
      },
    ]
    const { items } = applyChatEvent(old, { type: 'tool-end', callId: 'c', ok: true, detail: 'ok' })
    expect(items[2]).toMatchObject({
      status: 'done',
      view: { type: 'shell', stdout: 'ok', exitCode: 0 },
    })
  })
})

describe("a background run's conversation, from Claude Code's transcript", () => {
  it('folds the prompt, the steps, the subagent and the reply', () => {
    const items = foldConversation(fixtureLines('disk-agent'), {
      root: '/vault',
      subagent: (id) => (id === 'a475921f641d771fa' ? fixtureLines('disk-agent.sub') : null),
    })
    expect(ofKind(items, 'user').map((u) => u.text)).toEqual([
      expect.stringContaining('Use the Task tool'),
    ])
    const turn = ofKind(items, 'turn')[0]!
    expect(turn.endedAt).toBeGreaterThan(turn.startedAt)
    expect(turn.model).toBe('claude-haiku-5-5')
    const agent = tool(items, (t) => t.tool === 'Agent')
    expect(agent.view).toMatchObject({ type: 'agent', result: 'add, sub, mul' })
    expect(
      ofKind(items, 'tool')
        .filter((t) => t.parentId === agent.id)
        .map((t) => t.tool),
    ).toEqual(['Bash', 'Read'])
    expect(ofKind(items, 'assistant').at(-1)?.text).toBe(
      'calc.py defines three functions: add, sub, mul.',
    )
  })

  it('leaves a live run’s last turn open, and names the folder as Claude Code does', () => {
    const items = foldConversation(fixtureLines('disk-agent'), { root: '/vault', live: true })
    expect(ofKind(items, 'turn')[0]!.endedAt).toBeUndefined()
    expect(projectSlug('/Users/me/Library/Holi/vaults/mara.notes')).toBe(
      '-Users-me-Library-Holi-vaults-mara-notes',
    )
    expect(isConversationId('../../etc/passwd')).toBe(false)
  })
})
