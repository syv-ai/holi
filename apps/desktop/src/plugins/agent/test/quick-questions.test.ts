import { describe, expect, it, vi } from 'vitest'
import { createQuestionDesk } from '../main/host/questions'
import { answersComplete, joinPicked, parseAskInput } from '../shared/questions'

/** A tool input as Claude Code's AskUserQuestion sends it. */
const TOOL_INPUT = {
  questions: [
    {
      question: 'Which naming scheme?',
      header: 'Names',
      multiSelect: false,
      options: [
        { label: 'Date first (Recommended)', description: 'YYYY-MM-DD title' },
        { label: 'Title only', description: 'No date' },
      ],
    },
  ],
}

/** The hook's stdin: the tool call, with Claude Code's own fields around it. */
const hookInput = (over: Record<string, unknown> = {}) => ({
  session_id: 'abc',
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_use_id: 'toolu_1',
  tool_input: TOOL_INPUT,
  ...over,
})

describe('parseAskInput', () => {
  it('reads the questions, with their headers, options and descriptions', () => {
    expect(parseAskInput(TOOL_INPUT)).toEqual([
      {
        question: 'Which naming scheme?',
        header: 'Names',
        multiSelect: false,
        options: [
          { label: 'Date first (Recommended)', description: 'YYYY-MM-DD title' },
          { label: 'Title only', description: 'No date' },
        ],
      },
    ])
  })

  it('refuses what it cannot show, so Claude Code asks the ordinary way', () => {
    expect(parseAskInput(null)).toBeNull()
    expect(parseAskInput({ questions: [] })).toBeNull()
    expect(parseAskInput({ questions: Array(5).fill(TOOL_INPUT.questions[0]) })).toBeNull()
    const noLabel = { questions: [{ question: 'Q?', options: [{ description: 'x' }] }] }
    expect(parseAskInput(noLabel)).toBeNull()
    const twice = { questions: [TOOL_INPUT.questions[0], TOOL_INPUT.questions[0]] }
    expect(parseAskInput(twice)).toBeNull()
  })
})

describe('answers', () => {
  const questions = parseAskInput(TOOL_INPUT)!

  it('are complete when every question has words, and only then', () => {
    expect(answersComplete(questions, { 'Which naming scheme?': 'Title only' })).toBe(true)
    expect(answersComplete(questions, {})).toBe(false)
    expect(answersComplete(questions, { 'Which naming scheme?': '  ' })).toBe(false)
    expect(answersComplete(questions, { 'Which naming scheme?': 'x', extra: 'y' })).toBe(false)
  })

  it('join a multi-select in the order offered', () => {
    const options = [{ label: 'A' }, { label: 'B' }, { label: 'C' }]
    expect(joinPicked(options, new Set([2, 0]))).toBe('A, C')
  })
})

describe('the question desk', () => {
  const desk = (onChange = vi.fn()) => ({
    onChange,
    desk: createQuestionDesk({ onChange, now: () => 1_000 }),
  })

  it('holds a question until it is answered, then hands the hook its answer', async () => {
    const { desk: d, onChange } = desk()
    const held = d.ask('job00001', hookInput(), new AbortController().signal)
    expect(d.has('job00001')).toBe(true)
    expect(d.pending()).toEqual([
      expect.objectContaining({ id: 'toolu_1', job: 'job00001', askedAt: 1_000 }),
    ])
    expect(onChange).toHaveBeenCalledTimes(1)

    expect(d.answer('toolu_1', { 'Which naming scheme?': 'Title only' })).toBe(true)
    expect(await held).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        // The tool input as Claude Code sent it, with the answers beside it.
        updatedInput: { ...TOOL_INPUT, answers: { 'Which naming scheme?': 'Title only' } },
      },
    })
    expect(d.has('job00001')).toBe(false)
  })

  it('refuses an answer that leaves a question unanswered, and keeps holding', () => {
    const { desk: d } = desk()
    void d.ask('job00001', hookInput(), new AbortController().signal)
    expect(d.answer('toolu_1', {})).toBe(false)
    expect(d.answer('nope', { 'Which naming scheme?': 'x' })).toBe(false)
    expect(d.has('job00001')).toBe(true)
  })

  it('answers nothing for a call it cannot show', async () => {
    const { desk: d, onChange } = desk()
    const held = d.ask(
      'job00001',
      hookInput({ tool_input: { questions: [] } }),
      new AbortController().signal,
    )
    expect(await held).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('lets go when the hook hangs up', async () => {
    const { desk: d } = desk()
    const hangUp = new AbortController()
    const held = d.ask('job00001', hookInput(), hangUp.signal)
    hangUp.abort()
    expect(await held).toBeNull()
    expect(d.pending()).toEqual([])
  })

  it("lets go of a session's questions unanswered when it stops", async () => {
    const { desk: d } = desk()
    const one = d.ask('job00001', hookInput(), new AbortController().signal)
    const other = d.ask(
      'job00002',
      hookInput({ tool_use_id: 'toolu_2' }),
      new AbortController().signal,
    )
    d.release('job00001')
    expect(await one).toBeNull()
    expect(d.pending().map((q) => q.job)).toEqual(['job00002'])
    d.releaseAll()
    expect(await other).toBeNull()
  })

  it('mints an id when Claude Code gives none, or one it already holds', () => {
    let n = 0
    const d = createQuestionDesk({ onChange: () => {}, mintId: () => `minted-${++n}` })
    void d.ask('job00001', hookInput({ tool_use_id: undefined }), new AbortController().signal)
    void d.ask('job00002', hookInput({ tool_use_id: 'toolu_1' }), new AbortController().signal)
    void d.ask('job00003', hookInput({ tool_use_id: 'toolu_1' }), new AbortController().signal)
    expect(d.pending().map((q) => q.id)).toEqual(['minted-1', 'toolu_1', 'minted-2'])
  })
})
