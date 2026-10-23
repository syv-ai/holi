/**
 * The reader never throws and never returns a malformed entry, whatever the
 * line holds: hostile shapes by hand, then a deterministic fuzz over mutations
 * of valid lines.
 */
import { describe, expect, it } from 'vitest'
import { classifyLine, shapeKey } from '../main/claude/transcript'
import type { ChatEntry, LineResult } from '../main/claude/transcript'
import { assistant, attachment, json, system, toolResult, toolUse, user } from './transcript-lines'

const KINDS = new Set([
  'user',
  'assistant',
  'thinking',
  'tool',
  'tool-result',
  'command',
  'shell',
  'interrupt',
  'notice',
  'compaction',
  'turn-end',
  'task-note',
  'unknown',
])

/** What every result must satisfy, whatever went in. */
function expectWellFormed(result: LineResult): void {
  expect(Array.isArray(result.entries)).toBe(true)
  expect(['rendered', 'hidden', 'unknown']).toContain(result.disposition.kind)
  for (const entry of result.entries as ChatEntry[]) {
    expect(KINDS.has(entry.kind)).toBe(true)
    expect(typeof entry.id).toBe('string')
    expect(entry.id).not.toBe('')
    // It crosses IPC: it must survive JSON and structured clone.
    expect(() => structuredClone(entry)).not.toThrow()
    expect(() => JSON.stringify(entry)).not.toThrow()
  }
  if (result.disposition.kind === 'rendered') expect(result.entries.length).toBeGreaterThan(0)
  if (result.disposition.kind === 'hidden') expect(result.entries).toEqual([])
}

describe('hostile lines', () => {
  it('survives anything that is not an object', () => {
    for (const line of [
      '',
      '   ',
      'null',
      '42',
      'true',
      '"text"',
      '[]',
      '[1,{"type":"user"}]',
      '{',
      '}{',
      '\u0000',
    ]) {
      expectWellFormed(classifyLine(line))
    }
    expect(classifyLine('null').disposition).toEqual({ kind: 'unknown', shape: 'json|null' })
    expect(classifyLine('').disposition).toEqual({ kind: 'hidden', reason: 'empty' })
    expect(classifyLine('not json').entries).toHaveLength(1)
  })

  it('survives a value that is not even a string', () => {
    for (const bad of [undefined, null, 5, {}, []]) {
      expectWellFormed(classifyLine(bad as unknown as string))
    }
  })

  it('survives lines too large to parse, and nesting too deep for JSON', () => {
    const big = classifyLine(`{"type":"user","note":"${'a'.repeat(5 * 1024 * 1024)}"}`)
    expect(big.entries).toHaveLength(1)
    expect(big.entries[0]).toMatchObject({ kind: 'unknown', shape: 'oversize' })
    expect(big.disposition).toEqual({ kind: 'unknown', shape: 'oversize' })
    const deep = '['.repeat(200_000) + ']'.repeat(200_000)
    expectWellFormed(classifyLine(deep))
    expectWellFormed(classifyLine(`{"type":"assistant","a":${deep}}`))
  })

  it('survives fields of the wrong type', () => {
    const rows: unknown[] = [
      { type: 'user' },
      { type: 'user', uuid: 5, message: 'text' },
      { type: 'user', uuid: 'u', message: { content: 5 } },
      { type: 'user', uuid: 'u', message: { content: null } },
      { type: 'user', uuid: 'u', message: { content: [null, 1, 'x', [], {}] } },
      {
        type: 'user',
        uuid: 'u',
        message: { content: [{ type: 'text' }, { type: 'text', text: 5 }] },
      },
      { type: 'user', uuid: 'u', message: { content: [{ type: 'tool_result', tool_use_id: 5 }] } },
      {
        type: 'user',
        uuid: 'u',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: { a: 1 } }] },
      },
      { type: 'user', uuid: 'u', isCompactSummary: true },
      { type: 'user', uuid: 'u', message: { content: 'x' }, origin: 'peer' },
      { type: 'assistant', uuid: 'a', message: { content: 'plain string' } },
      { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use' }] } },
      {
        type: 'assistant',
        uuid: 'a',
        message: { content: [{ type: 'tool_use', id: 5, name: 5, input: 'x' }] },
      },
      {
        type: 'assistant',
        uuid: 'a',
        message: {
          content: [
            { type: 'thinking', thinking: 5 },
            { type: 'text', text: null },
          ],
        },
      },
      { type: 'assistant', uuid: 'a', isApiErrorMessage: true },
      { type: 'attachment' },
      { type: 'attachment', attachment: 'x' },
      { type: 'attachment', attachment: { type: 'queued_command' } },
      { type: 'attachment', attachment: { type: 'queued_command', prompt: 5, origin: 'human' } },
      {
        type: 'attachment',
        attachment: { type: 'hook_non_blocking_error', exitCode: 'x', stderr: 5 },
      },
      { type: 'attachment', attachment: { type: 'task_status', description: {}, status: [] } },
      { type: 'system' },
      { type: 'system', subtype: 5 },
      { type: 'system', subtype: 'compact_boundary', compactMetadata: 'x' },
      { type: 'system', subtype: 'turn_duration', durationMs: -5 },
      { type: 'system', subtype: 'local_command', commandRun: 5, content: 5 },
      { type: 'system', subtype: 'stop_hook_summary', hookErrors: [null, 5, { a: 1 }] },
      { type: ['user'] },
      { type: 5, uuid: 'x' },
    ]
    for (const row of rows) expectWellFormed(classifyLine(json(row)))
  })

  it('does not look anything up on a prototype', () => {
    // A name like `constructor` or `__proto__` is data, never a table hit.
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      for (const row of [{ type: name }, attachment('x', { type: name }), system('x', name)]) {
        const result = classifyLine(json(row))
        expectWellFormed(result)
        expect(result.disposition.kind).toBe('unknown')
      }
      const call = classifyLine(json(assistant('a', [toolUse('t', name, { [name]: name })])))
        .entries[0]
      expect(call).toMatchObject({ kind: 'tool', name })
    }
    const polluted = classifyLine('{"__proto__":{"type":"user"},"uuid":"x"}')
    expect(polluted.disposition).toEqual({ kind: 'unknown', shape: 'untyped|none' })
    expect(({} as Record<string, unknown>)['type']).toBeUndefined()
  })

  it('treats a tool result with prototype-ish keys as inert data', () => {
    const line =
      '{"type":"user","uuid":"u","message":{"content":[{"type":"tool_result","tool_use_id":"constructor","content":"x"}]},"toolUseResult":{"__proto__":{"polluted":1},"constructor":{"prototype":1}}}'
    const result = classifyLine(line)
    expectWellFormed(result)
    expect(result.entries[0]).toMatchObject({ kind: 'tool-result', id: 'constructor' })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('gives shapeKey the same safety', () => {
    expect(shapeKey({ type: '__proto__' })).toBe('__proto__')
    expect(shapeKey(Object.create(null))).toBe('untyped|none')
  })

  it('does not take quadratic time on unclosed wrappers', () => {
    const started = Date.now()
    const text = '<system-reminder>'.repeat(50_000)
    expectWellFormed(classifyLine(json(user('u', text))))
    expectWellFormed(
      classifyLine(json(user('u', `<task-notification>${'<status>'.repeat(50_000)}`))),
    )
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VALID: unknown[] = [
  user('u1', 'hello'),
  user('u2', [
    { type: 'text', text: 'see' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJDZGVm'.repeat(80) },
    },
  ]),
  user('u3', '<command-name>/model</command-name><command-args>opus</command-args>'),
  user('u4', '<bash-input>ls</bash-input><bash-stdout>a</bash-stdout>'),
  user(
    'u5',
    '<task-notification><task-id>t</task-id><status>completed</status><summary>s</summary></task-notification>',
    { origin: { kind: 'task-notification' } },
  ),
  user('u6', [toolResult('toolu_1', 'out', { is_error: true })], {
    toolUseResult: {
      stdout: 'o',
      structuredPatch: [{ oldStart: 1, lines: ['+a'] }],
      file: { filePath: 'f', content: 'c' },
    },
  }),
  user('u7', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
  user('u8', 'Summary text', { isCompactSummary: true }),
  assistant('a1', [
    { type: 'text', text: 'hi' },
    { type: 'thinking', thinking: '', signature: 's' },
    toolUse('toolu_2', 'Write', { file_path: 'f', content: 'body' }),
  ]),
  assistant('a2', [{ type: 'text', text: 'oops' }], {
    isApiErrorMessage: true,
    error: 'server_error',
  }),
  attachment('t1', { type: 'queued_command', prompt: 'later', origin: { kind: 'human' } }),
  attachment('t2', { type: 'hook_non_blocking_error', hookName: 'h', exitCode: 1, stderr: 'bad' }),
  attachment('t3', { type: 'task_status', description: 'job', status: 'running' }),
  attachment('t4', { type: 'skill_listing', rendered: [{ content: 'x' }] }),
  system('s1', 'turn_duration', { durationMs: 10 }),
  system('s2', 'compact_boundary', {
    compactMetadata: { trigger: 'manual', preTokens: 5, postTokens: 1 },
  }),
  system('s3', 'local_command', {
    content: '<local-command-stdout>ok</local-command-stdout>',
    commandRun: { command: '/x', args: 'y' },
  }),
  system('s4', 'stop_hook_summary', { hookErrors: ['bad'] }),
  { type: 'queue-operation', operation: 'enqueue', content: 'x' },
]

const JUNK: unknown[] = [
  null,
  5,
  -1,
  1e308,
  true,
  '',
  'x',
  '<system-reminder>',
  '__proto__',
  'A'.repeat(6000),
  [],
  [null],
  {},
  { type: 'text' },
  { type: 'tool_result' },
  { type: 'image', source: 5 },
  { __proto__: 1, constructor: 2 },
]

/** The value at a random place in `tree`, replaced. */
function mutateTree(tree: unknown, next: () => number): unknown {
  const paths: (string | number)[][] = []
  const collect = (node: unknown, path: (string | number)[]): void => {
    paths.push(path)
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node))
        collect((node as Record<string, unknown>)[key], [...path, key])
    }
  }
  collect(tree, [])
  const path = paths[Math.floor(next() * paths.length)]!
  const replacement = JUNK[Math.floor(next() * JUNK.length)]
  if (path.length === 0) return replacement
  const root = JSON.parse(JSON.stringify(tree)) as Record<string, unknown>
  let node: Record<string, unknown> = root
  for (const key of path.slice(0, -1)) node = node[key as string] as Record<string, unknown>
  const last = path.at(-1) as string
  if (next() < 0.15) delete node[last]
  else node[last] = replacement
  return root
}

function mutateText(text: string, next: () => number): string {
  const at = Math.floor(next() * text.length)
  switch (Math.floor(next() * 5)) {
    case 0:
      return text.slice(0, at)
    case 1:
      return text.slice(0, at) + text.slice(at + 1 + Math.floor(next() * 10))
    case 2:
      return text.slice(0, at) + String.fromCharCode(Math.floor(next() * 0x10000)) + text.slice(at)
    case 3:
      return text.slice(at)
    default:
      return text.slice(0, at) + text.slice(at, at + 20).repeat(3) + text.slice(at)
  }
}

describe('fuzz', () => {
  it('never throws and never returns a malformed entry, over mutations of valid lines', () => {
    const next = rng(20260107)
    const sidechain = [false, true]
    let seen = 0
    for (let round = 0; round < 6000; round += 1) {
      const base = VALID[Math.floor(next() * VALID.length)]
      let mutated: unknown = base
      for (let n = Math.floor(next() * 3); n >= 0; n -= 1) mutated = mutateTree(mutated, next)
      let line = JSON.stringify(mutated) ?? 'undefined'
      if (next() < 0.3) line = mutateText(line, next)
      const result = classifyLine(line, { sidechain: sidechain[round % 2]!, at: round })
      expectWellFormed(result)
      seen += result.entries.length
    }
    // The valid lines themselves do produce entries: the loop is not vacuous.
    expect(seen).toBeGreaterThan(1000)
  })

  it('reads every valid line it mutates from', () => {
    for (const row of VALID) {
      const result = classifyLine(json(row))
      expectWellFormed(result)
      expect(result.disposition.kind === 'unknown').toBe(false)
    }
  })
})
