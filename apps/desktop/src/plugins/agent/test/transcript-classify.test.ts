/**
 * What each kind of transcript line becomes: the rules of
 * `main/claude/transcript/classify.ts`, one synthetic line at a time.
 */
import { describe, expect, it } from 'vitest'
import { classifyLine, parseTranscriptLine, shapeKey } from '../main/claude/transcript'
import { assistant, attachment, json, system, toolResult, toolUse, user } from './transcript-lines'

const entries = (row: unknown, sidechain = false) => classifyLine(json(row), { sidechain }).entries
const disposition = (row: unknown, sidechain = false) =>
  classifyLine(json(row), { sidechain }).disposition

describe('user messages', () => {
  it('reads what the person typed', () => {
    expect(entries(user('u1', 'hello'))).toEqual([{ kind: 'user', id: 'u1', text: 'hello' }])
    expect(disposition(user('u1', 'hello'))).toEqual({ kind: 'rendered' })
  })

  it('reads text and counts the pictures sent with it', () => {
    const row = user('u1', [
      { type: 'text', text: 'look at [Image #1]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])
    expect(entries(row)).toEqual([
      { kind: 'user', id: 'u1', text: 'look at [Image #1]', images: 1 },
    ])
  })

  it('strips a system reminder and keeps what follows it', () => {
    expect(entries(user('u1', '<system-reminder>note</system-reminder>do it'))).toEqual([
      { kind: 'user', id: 'u1', text: 'do it' },
    ])
  })

  it('hides a message that is only a reminder or a caveat', () => {
    for (const text of [
      '<system-reminder>only</system-reminder>',
      '<local-command-caveat>Caveat: not from the person</local-command-caveat>',
    ]) {
      expect(classifyLine(json(user('u1', text)))).toEqual(
        expect.objectContaining({
          entries: [],
          disposition: { kind: 'hidden', reason: 'machinery' },
        }),
      )
    }
  })

  describe('harness text', () => {
    const headers = [
      '[Workflow harness \u2014 computed task] go on',
      '[Workflow harness \u2014 user request] go on',
      '[structured-output-enforce] call the tool',
      '[handback-send-enforce] call the tool',
      '[SYSTEM NOTIFICATION - NOT USER INPUT]\nsomething finished',
      '[Your previous response had no visible output. Please continue and produce a user-visible response.]',
      '[Image: source: /tmp/a.png]',
    ]
    const sub = { isSidechain: true }

    it('hides the exact harness formats on a sub-agent line that is not a person\u2019s', () => {
      for (const text of headers) {
        for (const extra of [
          sub,
          { ...sub, isMeta: true },
          { ...sub, origin: { kind: 'task-notification' } },
        ]) {
          const result = classifyLine(json(user('u1', text, extra)), { sidechain: true })
          expect(result.entries, text).toEqual([])
          expect(result.disposition, text).toEqual({ kind: 'hidden', reason: 'machinery' })
        }
      }
    })

    it('hides the exact harness formats in the text blocks of an isMeta line', () => {
      const row = user('u1', [{ type: 'text', text: '[Image: source: /tmp/a.png]' }], {
        isMeta: true,
        turnCompanion: true,
      })
      expect(classifyLine(json(row)).entries).toEqual([])
    })

    it('shows a person\u2019s own message that merely starts like a harness line', () => {
      for (const text of [
        '[structured logging] add it to the api',
        '[structured-output] is the name of my module',
        '[Image: source of the bug] see it',
        '[Image: source: not closed',
        '[handback notes] summarise',
        '[Workflow harness notes] fix',
        '[Workflow harness \u2014 computed task]',
        '[SYSTEM NOTIFICATION] read this',
        '[Your previous response was wrong] redo it',
      ]) {
        for (const extra of [{}, { origin: { kind: 'human' } }]) {
          const found = entries(user('u1', text, extra))
          expect(found, text).toEqual([{ kind: 'user', id: 'u1', text }])
        }
        // A sub-agent file with a human origin is still the person's.
        const inSub = classifyLine(json(user('u1', text, { ...sub, origin: { kind: 'human' } })), {
          sidechain: true,
        })
        expect(inSub.entries, text).toEqual([{ kind: 'user', id: 'u1', text }])
      }
    })

    it('never hides the exact formats on a main-conversation line without an isMeta', () => {
      for (const text of headers) {
        for (const extra of [{}, { origin: { kind: 'human' } }]) {
          expect(entries(user('u1', text, extra)), text).toEqual([{ kind: 'user', id: 'u1', text }])
        }
      }
    })

    it('shows a person\u2019s queued message that starts like a harness line', () => {
      const row = attachment('a1', {
        type: 'queued_command',
        prompt: '[structured logging] add it',
        commandMode: 'prompt',
        origin: { kind: 'human' },
      })
      expect(entries(row)).toEqual([
        { kind: 'user', id: 'a1', text: '[structured logging] add it', queued: true },
      ])
    })
  })

  it('hides isMeta lines', () => {
    const result = classifyLine(json(user('u1', 'meta', { isMeta: true })))
    expect(result.entries).toEqual([])
    expect(result.disposition).toEqual({ kind: 'hidden', reason: 'machinery' })
  })

  it('keeps unknown leading tags as the text they are', () => {
    expect(entries(user('u1', '<made-up>hello</made-up>'))).toEqual([
      { kind: 'user', id: 'u1', text: '<made-up>hello</made-up>' },
    ])
  })

  it('reads a slash command as a command', () => {
    const text =
      '<command-message>compact</command-message>\n<command-name>/compact</command-name>\n<command-args>now</command-args>'
    expect(entries(user('u1', text))).toEqual([
      { kind: 'command', id: 'u1', name: '/compact', args: 'now' },
    ])
  })

  it('reads a local command output and a ! shell command as shell entries', () => {
    expect(entries(user('u1', '<local-command-stdout>ok\nfine</local-command-stdout>'))).toEqual([
      { kind: 'shell', id: 'u1', stdout: 'ok\nfine' },
    ])
    expect(
      entries(
        user(
          'u2',
          '<bash-input>ls</bash-input><bash-stdout>a b</bash-stdout><bash-stderr></bash-stderr>',
        ),
      ),
    ).toEqual([{ kind: 'shell', id: 'u2', command: 'ls', stdout: 'a b' }])
    expect(
      classifyLine(json(user('u3', '<local-command-stdout></local-command-stdout>'))).disposition,
    ).toEqual({
      kind: 'hidden',
      reason: 'empty',
    })
  })

  it('reads a task notification, with its ids and status', () => {
    const text =
      '<task-notification><task-id>t-9</task-id><tool-use-id>toolu_a</tool-use-id><status>completed</status><summary>Agent finished</summary><result>long</result></task-notification>'
    expect(entries(user('u1', text, { origin: { kind: 'task-notification' } }))).toEqual([
      {
        kind: 'task-note',
        id: 'u1',
        taskId: 't-9',
        toolUseId: 'toolu_a',
        status: 'completed',
        summary: 'Agent finished',
      },
    ])
  })

  it('reads a monitor event, which has no status', () => {
    const text =
      '<task-notification><task-id>m-1</task-id><event>line printed</event></task-notification>'
    expect(entries(user('u1', text))).toEqual([
      { kind: 'task-note', id: 'u1', taskId: 'm-1', status: 'event', summary: 'line printed' },
    ])
  })

  it('reads a hand-back from another agent as a peer notice', () => {
    const row = user('u1', '<agent-message from="abc">Report ready</agent-message>', {
      origin: { kind: 'peer' },
    })
    expect(entries(row)).toEqual([
      expect.objectContaining({
        kind: 'notice',
        source: 'peer',
        tone: 'info',
        text: 'Report ready',
      }),
    ])
  })

  it('reads an interruption, in a text block, for a reply or for a tool', () => {
    expect(entries(user('u1', [{ type: 'text', text: '[Request interrupted by user]' }]))).toEqual([
      { kind: 'interrupt', id: 'u1:0', forTool: false },
    ])
    expect(
      entries(user('u2', [{ type: 'text', text: '[Request interrupted by user for tool use]' }])),
    ).toEqual([{ kind: 'interrupt', id: 'u2:0', forTool: true }])
  })

  it('shows a compaction summary as a notice with the summary behind it', () => {
    const row = user('u1', 'The summary of the old conversation.', { isCompactSummary: true })
    expect(entries(row)).toEqual([
      {
        kind: 'notice',
        id: 'u1',
        source: 'compact-summary',
        tone: 'info',
        text: expect.any(String),
        detail: 'The summary of the old conversation.',
      },
    ])
  })

  it('names a line with no uuid by its place in the file', () => {
    const row = { type: 'user', message: { content: 'hi' } }
    expect(classifyLine(json(row), { at: 1234 }).entries).toEqual([
      { kind: 'user', id: 'L1234', text: 'hi' },
    ])
  })
})

describe('assistant messages', () => {
  it('reads text, and gives each block its own id', () => {
    const row = assistant('a1', [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])
    expect(entries(row)).toEqual([
      { kind: 'assistant', id: 'a1:0', text: 'one' },
      { kind: 'assistant', id: 'a1:1', text: 'two' },
    ])
  })

  it('hides an empty thinking block with only its signature, shows one with text', () => {
    const hidden = classifyLine(
      json(assistant('a1', [{ type: 'thinking', thinking: '', signature: 'sig' }])),
    )
    expect(hidden.entries).toEqual([])
    expect(hidden.disposition).toEqual({ kind: 'hidden', reason: 'empty' })
    expect(
      entries(assistant('a2', [{ type: 'thinking', thinking: 'Weighing it.', signature: 's' }])),
    ).toEqual([{ kind: 'thinking', id: 'a2:0', text: 'Weighing it.' }])
  })

  it('reads a tool call by the call id, with its input and a summary', () => {
    const row = assistant('a1', [
      toolUse('toolu_1', 'Read', { file_path: 'notes/a.md', offset: 3 }),
    ])
    expect(entries(row)).toEqual([
      {
        kind: 'tool',
        id: 'toolu_1',
        name: 'Read',
        summary: 'notes/a.md',
        args: { file_path: 'notes/a.md', offset: 3 },
      },
    ])
  })

  it('takes the summary from the first key that has one, first line only, 160 characters', () => {
    const summary = (input: unknown) =>
      (entries(assistant('a', [toolUse('t', 'X', input)]))[0] as { summary: string }).summary
    expect(summary({ command: 'ls', description: 'List files' })).toBe('List files')
    expect(summary({ prompt: 'p', name: 'n' })).toBe('p')
    expect(summary({ title: 'T' })).toBe('T')
    expect(summary({ description: 'first\nsecond' })).toBe('first')
    expect(summary({ command: 'x'.repeat(500) })).toHaveLength(160)
    expect(summary({ description: '', path: '/p' })).toBe('/p')
    expect(summary({})).toBe('')
  })

  it('gives parallel calls in one message their own entries by call id', () => {
    const lineA = assistant('a1', [toolUse('toolu_a', 'Bash', { command: 'a' })])
    const lineB = assistant('a2', [toolUse('toolu_b', 'Bash', { command: 'b' })])
    expect([...entries(lineA), ...entries(lineB)].map((e) => e.id)).toEqual(['toolu_a', 'toolu_b'])
  })

  it('shows an API error as an error notice', () => {
    const row = assistant('a1', [{ type: 'text', text: 'API Error: overloaded' }], {
      isApiErrorMessage: true,
      error: 'server_error',
    })
    expect(entries(row)).toEqual([
      {
        kind: 'notice',
        id: 'a1',
        source: 'api-error',
        tone: 'error',
        text: 'API Error: overloaded',
        detail: 'server_error',
      },
    ])
  })

  it('marks a stream that was cut off as an interruption', () => {
    const row = assistant('a1', [{ type: 'text', text: 'half a thou' }], {
      isAbortedMidStream: true,
    })
    expect(entries(row).map((e) => e.kind)).toEqual(['assistant', 'interrupt'])
  })

  it('shows an unknown content block as an unknown entry, beside the blocks it knows', () => {
    const row = assistant('a1', [
      { type: 'text', text: 'ok' },
      { type: 'server_tool_use', id: 'x', name: 'web_search' },
    ])
    const result = classifyLine(json(row))
    expect(result.entries.map((e) => e.kind)).toEqual(['assistant', 'unknown'])
    expect(result.entries[1]).toMatchObject({
      kind: 'unknown',
      id: 'a1:1',
      shape: 'assistant|block:server_tool_use',
    })
    expect((result.entries[1] as { raw: string }).raw).toContain('web_search')
    expect(result.disposition).toEqual({
      kind: 'unknown',
      shape: 'assistant|block:server_tool_use',
    })
  })
})

describe('tool results', () => {
  it('reads a text result under the call id, ok unless Claude Code said otherwise', () => {
    expect(entries(user('u1', [toolResult('toolu_1', 'done')]))).toEqual([
      { kind: 'tool-result', id: 'toolu_1', ok: true, text: 'done' },
    ])
    expect(entries(user('u2', [toolResult('toolu_1', 'x', { is_error: false })]))[0]).toMatchObject(
      { ok: true },
    )
    expect(
      entries(user('u3', [toolResult('toolu_1', 'no file', { is_error: true })]))[0],
    ).toMatchObject({
      ok: false,
      text: 'no file',
    })
  })

  it('treats the harness refusal and a non-zero exit as failures when the flag is absent', () => {
    expect(
      entries(user('u1', [toolResult('t', '<tool_use_error>Blocked: sleep</tool_use_error>')]))[0],
    ).toMatchObject({ ok: false, text: 'Blocked: sleep' })
    expect(entries(user('u2', [toolResult('t', 'Exit code 2\nboom')]))[0]).toMatchObject({
      ok: false,
    })
    expect(entries(user('u3', [toolResult('t', 'Exit code 0 was fine')]))[0]).toMatchObject({
      ok: true,
    })
    expect(entries(user('u4', [toolResult('t', 'Error: but no flag')]))[0]).toMatchObject({
      ok: true,
    })
  })

  it('reads an array result: text blocks joined, pictures as references, tool names listed', () => {
    const row = user('u1', [
      toolResult('toolu_1', [
        { type: 'text', text: 'a' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4000) },
        },
        { type: 'tool_reference', tool_name: 'Grep' },
        { type: 'future_block' },
      ]),
    ])
    expect(entries(row)).toEqual([
      {
        kind: 'tool-result',
        id: 'toolu_1',
        ok: true,
        text: 'a\nGrep\n[unsupported block: future_block]',
        images: [{ mediaType: 'image/png', bytes: 3000 }],
      },
    ])
  })

  it('keeps a persisted-output wrapper as the text it is', () => {
    const text =
      '<persisted-output>\nOutput too large (50KB). Full output saved to: x\n</persisted-output>'
    expect(entries(user('u1', [toolResult('t', text)]))[0]).toMatchObject({ text })
  })

  it('carries the sanitised structured twin as data, when the line has one', () => {
    const row = user('u1', [toolResult('t', 'out')], {
      toolUseResult: { stdout: 'out', stderr: '', interrupted: false, isImage: false },
    })
    expect(entries(row)[0]).toMatchObject({
      data: { stdout: 'out', stderr: '', interrupted: false, isImage: false },
    })
    // An error's twin is a string: the text again, so no data.
    const err = user('u2', [toolResult('t', 'Error: x', { is_error: true })], {
      toolUseResult: 'Error: x',
    })
    expect(entries(err)[0]).not.toHaveProperty('data')
  })

  it('gives the twin to no result when a line holds several', () => {
    const row = user('u1', [toolResult('a', '1'), toolResult('b', '2')], {
      toolUseResult: { x: 1 },
    })
    for (const e of entries(row)) expect(e).not.toHaveProperty('data')
  })

  it('shows a malformed result block as unknown, not nothing', () => {
    const result = classifyLine(json(user('u1', [{ type: 'tool_result', content: 'no id' }])))
    expect(result.entries[0]).toMatchObject({
      kind: 'unknown',
      shape: 'user|block:tool_result-malformed',
    })
  })

  it('shows an unknown user block as unknown', () => {
    const result = classifyLine(json(user('u1', [{ type: 'document', source: {} }])))
    expect(result.entries[0]).toMatchObject({
      kind: 'unknown',
      id: 'u1:0',
      shape: 'user|block:document',
    })
    expect(result.disposition).toEqual({ kind: 'unknown', shape: 'user|block:document' })
  })
})

describe('attachments', () => {
  it('hides what the model alone was told, saying why', () => {
    for (const type of [
      'skill_listing',
      'deferred_tools_delta',
      'task_reminder',
      'nested_memory',
      'total_tokens_reminder',
      'prompt_snapshot',
      'structured_output',
      'hook_success',
    ]) {
      const result = classifyLine(
        json(attachment('x1', { type, rendered: [{ content: 'private' }] })),
      )
      expect(result.entries).toEqual([])
      expect(result.disposition).toEqual({ kind: 'hidden', reason: 'model-facing' })
    }
  })

  it('reads a message typed while the agent was busy as a queued user message', () => {
    const row = attachment('q1', {
      type: 'queued_command',
      prompt: 'also do this',
      commandMode: 'prompt',
      origin: { kind: 'human' },
    })
    expect(entries(row)).toEqual([{ kind: 'user', id: 'q1', text: 'also do this', queued: true }])
  })

  it('reads a queued task notification as a task note and a peer hand-back as a notice', () => {
    const task = attachment('q2', {
      type: 'queued_command',
      commandMode: 'task-notification',
      origin: { kind: 'task-notification' },
      prompt:
        '<task-notification><task-id>t</task-id><status>failed</status><summary>Broke</summary></task-notification>',
    })
    expect(entries(task)).toEqual([
      { kind: 'task-note', id: 'q2', taskId: 't', status: 'failed', summary: 'Broke' },
    ])
    const peer = attachment('q3', {
      type: 'queued_command',
      prompt: '<agent-message from="x">Done</agent-message>',
      origin: { kind: 'peer', handback: true },
    })
    expect(entries(peer)[0]).toMatchObject({ kind: 'notice', source: 'peer' })
  })

  it('hides a queued reminder (isMeta)', () => {
    const row = attachment('q4', {
      type: 'queued_command',
      prompt: 'r',
      isMeta: true,
      origin: { kind: 'human' },
    })
    expect(disposition(row)).toEqual({ kind: 'hidden', reason: 'machinery' })
  })

  it('shows a failing hook as a warning, with its stderr behind it', () => {
    const row = attachment('h1', {
      type: 'hook_non_blocking_error',
      hookName: 'PostToolUse:Edit',
      hookEvent: 'PostToolUse',
      exitCode: 2,
      stderr: 'lint failed',
      stdout: '',
    })
    expect(entries(row)).toEqual([
      {
        kind: 'notice',
        id: 'h1',
        source: 'hook',
        tone: 'warn',
        text: 'PostToolUse:Edit failed (exit 2)',
        detail: 'lint failed',
      },
    ])
  })

  it('shows a hook message and a task status as notices', () => {
    expect(
      entries(attachment('h2', { type: 'hook_system_message', content: 'Formatted 3 files' })),
    ).toEqual([
      expect.objectContaining({
        kind: 'notice',
        source: 'hook',
        tone: 'info',
        text: 'Formatted 3 files',
      }),
    ])
    expect(
      entries(
        attachment('t1', {
          type: 'task_status',
          description: 'Build',
          status: 'completed',
          deltaSummary: 'ok',
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'notice',
        source: 'task',
        text: 'Build: completed',
        detail: 'ok',
      }),
    ])
  })

  it('hides an unknown attachment type but counts it', () => {
    const result = classifyLine(json(attachment('x', { type: 'brand_new_thing', rendered: [] })))
    expect(result.entries).toEqual([])
    expect(result.disposition).toEqual({ kind: 'unknown', shape: 'attachment|brand_new_thing' })
  })
})

describe('system lines', () => {
  it('turns a boundary, a duration and a recap into their entries', () => {
    expect(
      entries(
        system('s1', 'compact_boundary', {
          content: 'Conversation compacted',
          compactMetadata: {
            trigger: 'auto',
            preTokens: 100,
            postTokens: 20,
            preservedSegment: {},
          },
        }),
      ),
    ).toEqual([{ kind: 'compaction', id: 's1', trigger: 'auto', preTokens: 100, postTokens: 20 }])
    expect(entries(system('s2', 'turn_duration', { durationMs: 4200, messageCount: 3 }))).toEqual([
      { kind: 'turn-end', id: 's2', durationMs: 4200 },
    ])
    expect(
      entries(system('s3', 'away_summary', { content: 'While you were away: it built.' })),
    ).toEqual([
      {
        kind: 'notice',
        id: 's3',
        source: 'away',
        tone: 'info',
        text: 'While you were away: it built.',
      },
    ])
  })

  it('shows a refusal fallback as a warning', () => {
    expect(
      entries(
        system('s1', 'model_refusal_fallback', { content: 'Retrying with another model.' }),
      )[0],
    ).toMatchObject({
      kind: 'notice',
      source: 'refusal',
      tone: 'warn',
      text: 'Retrying with another model.',
    })
  })

  it('shows local_command and informational lines as notices with their level', () => {
    expect(
      entries(
        system('s1', 'local_command', {
          content: '<local-command-stdout>Model changed</local-command-stdout>',
          commandRun: { command: '/model', args: 'opus' },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'notice',
        source: 'local-command',
        text: '/model opus',
        detail: 'Model changed',
      }),
    ])
    expect(
      entries(system('s2', 'informational', { content: 'Heads up', level: 'warning' })),
    ).toEqual([
      expect.objectContaining({ kind: 'notice', source: 'info', tone: 'warn', text: 'Heads up' }),
    ])
  })

  it('hides a quiet stop-hook summary and warns when it holds errors', () => {
    expect(
      disposition(system('s1', 'stop_hook_summary', { hookErrors: [], hookInfos: [{}] })),
    ).toEqual({
      kind: 'hidden',
      reason: 'machinery',
    })
    expect(entries(system('s2', 'stop_hook_summary', { hookErrors: ['it failed'] }))).toEqual([
      expect.objectContaining({
        kind: 'notice',
        source: 'hook',
        tone: 'warn',
        detail: 'it failed',
      }),
    ])
  })

  it('shows an unknown subtype as an unknown entry', () => {
    const result = classifyLine(json(system('s1', 'future_event', { content: 'x' })))
    expect(result.entries).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        id: 's1',
        shape: 'system|future_event',
        version: '2.1.290',
      }),
    ])
    expect(result.disposition).toEqual({ kind: 'unknown', shape: 'system|future_event' })
  })

  it('shows a turn_duration without a duration rather than inventing one', () => {
    expect(entries(system('s1', 'turn_duration', { durationMs: 'soon' }))[0]).toMatchObject({
      kind: 'unknown',
      shape: 'system|turn_duration',
    })
  })
})

describe('lines that are not conversation', () => {
  it('hides session chrome and debug copies with a named reason', () => {
    for (const [type, reason] of [
      ['queue-operation', 'metadata'],
      ['last-prompt', 'metadata'],
      ['mode', 'metadata'],
      ['permission-mode', 'metadata'],
      ['custom-title', 'metadata'],
      ['pr-link', 'metadata'],
      ['cost-state', 'metadata'],
      ['file-history-snapshot', 'machinery'],
      ['api-request', 'debug-copy'],
      ['api-request-blob', 'debug-copy'],
      ['atis-latch', 'debug-copy'],
    ] as const) {
      expect(classifyLine(json({ type, message: { content: 'not a message' } }))).toEqual({
        entries: [],
        disposition: { kind: 'hidden', reason },
      })
    }
  })

  it('hides an unknown top-level type but counts it', () => {
    expect(classifyLine(json({ type: 'telepathy', n: 1 }))).toEqual({
      entries: [],
      disposition: { kind: 'unknown', shape: 'telepathy' },
    })
    expect(classifyLine(json({ no: 'type' })).disposition).toEqual({
      kind: 'unknown',
      shape: 'untyped|none',
    })
  })

  it('hides a sub-agent line met in the main file, and reads it in its own', () => {
    const row = assistant('a1', [{ type: 'text', text: 'inner' }], { isSidechain: true })
    expect(disposition(row)).toEqual({ kind: 'hidden', reason: 'sidechain' })
    expect(entries(row, true)).toEqual([{ kind: 'assistant', id: 'a1:0', text: 'inner' }])
  })

  it('reports the Claude Code version that wrote a line', () => {
    expect(classifyLine(json(user('u1', 'hi'))).version).toBe('2.1.290')
    expect(classifyLine(json({ type: 'mode' })).version).toBeUndefined()
  })
})

describe('parseTranscriptLine', () => {
  it('is the entries of classifyLine', () => {
    expect(parseTranscriptLine(json(user('u1', 'hello')))).toEqual([
      { kind: 'user', id: 'u1', text: 'hello' },
    ])
    expect(parseTranscriptLine('not json').map((e) => e.kind)).toEqual(['unknown'])
    expect(parseTranscriptLine(json({ type: 'mode' }))).toEqual([])
  })
})

describe('shapeKey', () => {
  it('names the fields that decide how a line is read', () => {
    expect(shapeKey(attachment('x', { type: 'queued_command' }))).toBe('attachment|queued_command')
    expect(shapeKey(system('x', 'turn_duration'))).toBe('system|turn_duration')
    expect(shapeKey({ type: 'mode' })).toBe('mode')
    expect(shapeKey(user('u', 'text'))).toBe('user')
  })

  it('is structure only: odd values become safe, bounded text', () => {
    expect(shapeKey(null)).toBe('json|null')
    expect(shapeKey([1])).toBe('json|array')
    expect(shapeKey(5)).toBe('json|number')
    expect(shapeKey({ type: 5 })).toBe('untyped|number')
    expect(shapeKey({ type: 'system', subtype: 'has space /secret/path' })).toBe(
      'system|has?space??secret?path',
    )
    expect(shapeKey({ type: 'x'.repeat(500) }).length).toBeLessThanOrEqual(48)
    expect(shapeKey({ type: 'attachment', attachment: 'oops' })).toBe('attachment|none')
  })
})
