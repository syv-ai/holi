/**
 * Tool inputs and the structured twin of a result, made safe to send: strings
 * clipped, base64 and huge lists replaced by markers, hostile keys inert.
 */
import { describe, expect, it } from 'vitest'
import { classifyLine } from '../main/claude/transcript'
import { LIMITS, sanitiseArgs, sanitiseResultData } from '../main/claude/transcript/sanitise'
import { assistant, json, toolResult, toolUse, user } from './transcript-lines'

const toolEntry = (name: string, input: unknown) =>
  classifyLine(json(assistant('a1', [toolUse('toolu_1', name, input)]))).entries[0] as {
    kind: 'tool'
    args: Record<string, unknown>
    clipped?: boolean
  }

describe('tool inputs', () => {
  it('clips other strings to 4000 characters and says so', () => {
    const entry = toolEntry('Bash', { command: 'x'.repeat(10_000), timeout: 5 })
    expect((entry.args['command'] as string).length).toBeLessThan(LIMITS.string + 5)
    expect(entry.args['timeout']).toBe(5)
    expect(entry.clipped).toBe(true)
  })

  it('lets a Write or Edit carry up to 20000 characters of what it writes', () => {
    const write = toolEntry('Write', { file_path: 'a.md', content: 'y'.repeat(15_000) })
    expect(write.args['content']).toHaveLength(15_000)
    expect(write.clipped).toBeUndefined()
    const edit = toolEntry('Edit', { old_string: 'a', new_string: 'z'.repeat(30_000) })
    expect((edit.args['new_string'] as string).length).toBeLessThan(20_010)
    expect(edit.clipped).toBe(true)
    // The long limit is for what is written, not for a command.
    const bash = toolEntry('Bash', { content: 'y'.repeat(15_000) })
    expect((bash.args['content'] as string).length).toBeLessThan(4010)
  })

  it('replaces base64 by a marker, by key or by look', () => {
    const blob = 'QUJDZGVmMDEy'.repeat(334).slice(0, 4000)
    const entry = toolEntry('mcp__x__attach', {
      content_base64: blob,
      note: blob,
      nested: { source: { type: 'base64', data: blob } },
    })
    expect(entry.args['content_base64']).toBe('<base64 4000 chars>')
    expect(entry.args['note']).toBe('<base64 4000 chars>')
    expect(entry.args['nested']).toEqual({
      source: { type: 'base64', data: '<base64 4000 chars>' },
    })
    expect(entry.clipped).toBe(true)
  })

  it('caps long lists and deep nesting with markers, and coerces nothing', () => {
    const entry = toolEntry('mcp__x__set_flow', {
      nodes: Array.from({ length: 200 }, (_, i) => i),
      deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
      timeout: '300000',
      run_in_background: 'true',
      offset: [1, 2],
    })
    const nodes = entry.args['nodes'] as unknown[]
    expect(nodes).toHaveLength(LIMITS.items + 1)
    expect(nodes.at(-1)).toBe('<150 more items>')
    expect(JSON.stringify(entry.args['deep'])).toContain('<object>')
    expect(entry.args['timeout']).toBe('300000')
    expect(entry.args['run_in_background']).toBe('true')
    expect(entry.args['offset']).toEqual([1, 2])
  })

  it('keeps a hostile key as inert data', () => {
    const line =
      '{"type":"assistant","uuid":"a","message":{"content":[{"type":"tool_use","id":"t","name":"constructor","input":{"__proto__":{"polluted":true},"constructor":"x"}}]}}'
    const entry = classifyLine(line).entries[0] as { name: string; args: Record<string, unknown> }
    expect(entry.name).toBe('constructor')
    expect(Object.keys(entry.args)).toEqual(['__proto__', 'constructor'])
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(Object.getPrototypeOf(entry.args)).toBe(Object.prototype)
  })

  it('answers an empty object for an input that is not one', () => {
    expect(sanitiseArgs('Bash', null).args).toEqual({})
    expect(sanitiseArgs('Bash', 'ls').args).toEqual({})
    expect(sanitiseArgs('Bash', [1]).args).toEqual({})
  })

  it('does not cut a character in two', () => {
    const entry = toolEntry('Bash', { command: `${'a'.repeat(LIMITS.string - 1)}😀tail` })
    const text = entry.args['command'] as string
    expect(text.endsWith('\n…')).toBe(true)
    expect(/[\ud800-\udbff]\n…$/.test(text)).toBe(false)
  })
})

describe('the structured twin of a result', () => {
  const data = (twin: unknown) =>
    classifyLine(json(user('u1', [toolResult('t', 'text')], { toolUseResult: twin })))
      .entries[0] as {
      data?: Record<string, unknown>
      clipped?: boolean
    }

  it('keeps a Bash result whole and clips its output to 4000', () => {
    const entry = data({
      stdout: 'o'.repeat(9000),
      stderr: 'e',
      interrupted: false,
      backgroundTaskId: 'bg-1',
      noOutputExpected: false,
    })
    expect(entry.data?.['stderr']).toBe('e')
    expect(entry.data?.['backgroundTaskId']).toBe('bg-1')
    expect((entry.data?.['stdout'] as string).length).toBeLessThan(4010)
    expect(entry.clipped).toBe(true)
  })

  it('keeps an edit’s patch and path, and drops the file text it repeats', () => {
    const entry = data({
      filePath: 'a.md',
      oldString: 'old',
      newString: 'new',
      originalFile: 'o'.repeat(5000),
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'], extra: 1 },
      ],
      userModified: false,
    })
    expect(entry.data).toEqual({
      filePath: 'a.md',
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
      ],
      userModified: false,
    })
  })

  it('keeps where a Read was, not what it read', () => {
    const entry = data({
      type: 'text',
      file: {
        filePath: 'a.md',
        content: 'secret body',
        numLines: 3,
        startLine: 1,
        totalLines: 9,
        base64: 'AAAA',
      },
    })
    expect(entry.data).toEqual({
      type: 'text',
      file: { filePath: 'a.md', numLines: 3, startLine: 1, totalLines: 9 },
    })
    expect(entry.clipped).toBe(true)
  })

  it('keeps an agent’s ids and totals, a question’s answers and a plan', () => {
    expect(
      data({
        status: 'completed',
        agentId: 'abc123',
        totalDurationMs: 5,
        totalTokens: 10,
        totalToolUseCount: 2,
      }).data,
    ).toEqual({
      status: 'completed',
      agentId: 'abc123',
      totalDurationMs: 5,
      totalTokens: 10,
      totalToolUseCount: 2,
    })
    expect(data({ questions: [{ question: 'Q?' }], answers: { 'Q?': 'yes' } }).data).toEqual({
      questions: [{ question: 'Q?' }],
      answers: { 'Q?': 'yes' },
    })
    const plan = data({ plan: 'p'.repeat(12_000), filePath: 'plan.md' })
    expect((plan.data?.['plan'] as string).length).toBe(12_000)
  })

  it('caps web search results at ten', () => {
    const results = Array.from({ length: 25 }, (_, i) => ({
      title: `t${i}`,
      url: `https://example.test/${i}`,
    }))
    const entry = data({ query: 'q', results, durationSeconds: 1.5 })
    expect(entry.data?.['results']).toHaveLength(LIMITS.searchResults)
    expect(entry.data?.['durationSeconds']).toBe(1.5)
    expect(entry.clipped).toBe(true)
  })

  it('gives nothing for a string or a list, which are the text again', () => {
    expect(sanitiseResultData('Error: x')).toEqual({ clipped: false })
    expect(sanitiseResultData([{ type: 'text', text: 'x' }])).toEqual({ clipped: false })
    expect(sanitiseResultData(null)).toEqual({ clipped: false })
  })

  it('bounds the whole of it', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`k${i}`, 'v'.repeat(3000)]),
    )
    const result = sanitiseResultData(wide)
    expect(Object.keys(result.data ?? {}).length).toBeLessThanOrEqual(LIMITS.keys)
    expect(JSON.stringify(result.data).length).toBeLessThan(LIMITS.dataBudget + 60 * 220)
    expect(result.clipped).toBe(true)
  })
})
