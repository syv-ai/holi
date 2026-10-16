/**
 * The tool card: one row per call that opens in place, drawn by the tool's
 * renderer and, when that cannot, by the generic view of the raw call.
 *
 * What is pinned: every family draws a well-formed call and a malformed one
 * (wrong types, missing fields, huge strings, hostile names) without throwing;
 * a renderer that answers null or throws, or whose body throws as it is drawn,
 * still shows the call; the card opens and closes from the keyboard; and an
 * error and a refusal can be told apart.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import type { ChatContext, ChatItem, ToolItem, ToolState } from '../../agent/renderer/chat/items'
import { ToolCard } from '../renderer/chat/rows/ToolCard'
import type { ToolRenderer } from '../renderer/chat/rows/registry'
import { clip } from '../renderer/chat/rows/tools/parts'
import { diffFromPatch, diffFromStrings } from '../renderer/chat/rows/tools/Diff'
import { humanName, parseMcp } from '../renderer/chat/rows/tools/generic'

const registry = vi.hoisted(() => ({ override: null as ToolRenderer | null }))
vi.mock('../renderer/chat/rows/tool-registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../renderer/chat/rows/tool-registry')>()
  return {
    ...real,
    rendererFor: (name: string) => registry.override ?? real.rendererFor(name),
  }
})

beforeAll(() => {
  // motion measures scroll positions while it animates; jsdom has none.
  window.scrollTo = () => undefined
})

afterEach(() => {
  registry.override = null
  vi.restoreAllMocks()
})

const ctx = (over: Partial<ChatContext> = {}): ChatContext => ({
  tasks: new Map(),
  loadSubagent: () => Promise.resolve([]),
  sessionId: 'sess',
  ...over,
})

function tool(
  name: string,
  args: Record<string, unknown>,
  result?: {
    text?: string
    ok?: boolean
    data?: Record<string, unknown>
    images?: { mediaType: string; bytes: number }[]
  },
  over: Partial<ToolItem> = {},
): ToolItem {
  const state: ToolState = result === undefined ? 'pending' : result.ok === false ? 'error' : 'done'
  return {
    kind: 'tool',
    id: `t-${name}`,
    name,
    summary: '',
    args,
    state,
    ...(result === undefined ? {} : { result: { ok: true, text: '', ...result } }),
    ...over,
  }
}

/** A call as a wrongly typed transcript could hand it over. */
const broken = (value: unknown): ToolItem => value as ToolItem

function mount(item: ToolItem, context: ChatContext = ctx()) {
  const view = render(<ToolCard item={item} ctx={context} />)
  const card = view.container.querySelector<HTMLElement>('[data-chat-tool]')!
  const toggle = card.querySelector<HTMLButtonElement>('button[aria-expanded]')
  return { ...view, card, toggle }
}

const body = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>('[data-chat-tool-body]')

// ── The shell ────────────────────────────────────────────────────────────────

test('a collapsed row is one line: the verb, the summary, and no body', () => {
  const { card } = mount(
    tool('Bash', { command: 'pnpm test', description: 'Run the tests' }, { text: 'ok' }),
  )
  expect(card).toHaveAttribute('data-chat-tool', 'Bash')
  expect(card).toHaveAttribute('data-chat-state', 'done')
  expect(within(card).getByText('Ran')).toBeInTheDocument()
  expect(within(card).getByText('Run the tests')).toBeInTheDocument()
  expect(body(card)).toBeNull()
})

test('a card opens and closes from the keyboard', async () => {
  const user = userEvent.setup()
  const { card, toggle } = mount(tool('Bash', { command: 'echo hi' }, { text: 'hi' }))
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  toggle!.focus()
  await user.keyboard('{Enter}')
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(body(card)).not.toBeNull()
  expect(within(body(card)!).getByText('echo hi')).toBeInTheDocument()
  await user.keyboard(' ')
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await waitFor(() => expect(body(card)).toBeNull())
})

test('an error and a refusal are told apart, in state and in glyph', () => {
  const failed = mount(tool('Bash', { command: 'false' }, { ok: false, text: 'Exit code 1\nboom' }))
  expect(failed.card).toHaveAttribute('data-chat-state', 'error')
  expect(failed.card.querySelector('[data-chat-status="error"]')).not.toBeNull()
  failed.unmount()
  const refused = mount(
    tool(
      'Bash',
      { command: 'rm -rf x' },
      { ok: false, text: "The user doesn't want to proceed" },
      { state: 'rejected' },
    ),
  )
  expect(refused.card).toHaveAttribute('data-chat-state', 'rejected')
  expect(refused.card.querySelector('[data-chat-status="rejected"]')).not.toBeNull()
  expect(within(refused.card).getByText('declined')).toBeInTheDocument()
  // The refusal's boilerplate is not shown as the command's output.
  expect(refused.card.textContent).not.toContain('proceed')
})

test('a pending call pulses and a finished one wears its glyph', () => {
  const pending = mount(tool('Read', { file_path: '/a/b.ts' }))
  expect(pending.card).toHaveAttribute('data-chat-state', 'pending')
  expect(pending.card.querySelector('.motion-pulse')).not.toBeNull()
  pending.unmount()
  const done = mount(tool('Read', { file_path: '/a/b.ts' }, { text: '1\tx' }))
  expect(done.card.querySelector('.motion-pulse')).toBeNull()
})

test('an unknown state is read from the result', () => {
  const { card } = mount(
    broken({ ...tool('Bash', { command: 'x' }, { text: 'y' }), state: 'weird' }),
  )
  expect(card).toHaveAttribute('data-chat-state', 'done')
})

test('a command that fails opens itself, and a plan opens from the start', () => {
  const failed = mount(tool('Bash', { command: 'false' }, { ok: false, text: 'Exit code 2\nnope' }))
  expect(failed.toggle).toHaveAttribute('aria-expanded', 'true')
  expect(within(failed.card).getByText('exit 2')).toBeInTheDocument()
  failed.unmount()
  const plan = mount(tool('ExitPlanMode', { plan: '# Do it\n\n- step one' }, { text: 'approved' }))
  expect(plan.toggle).toHaveAttribute('aria-expanded', 'true')
  expect(within(plan.card).getByText('step one')).toBeInTheDocument()
})

// ── The registry ─────────────────────────────────────────────────────────────

test('a hostile tool name resolves to nothing, not to the prototype', async () => {
  const real = await vi.importActual<typeof import('../renderer/chat/rows/tool-registry')>(
    '../renderer/chat/rows/tool-registry',
  )
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'mcp__', 'x']) {
    expect(real.rendererFor(name)).toBeUndefined()
  }
  expect(real.rendererFor(undefined as unknown as string)).toBeUndefined()
  expect(real.rendererFor('Task')).toBe(real.rendererFor('Agent'))
  expect(real.rendererFor('bash')).toBe(real.rendererFor('Bash'))
  expect(real.rendererFor('mcp__srv__tool')).toBeDefined()
  expect(real.rendererFor('mcp__Claude_Browser__computer')).not.toBe(
    real.rendererFor('mcp__srv__tool'),
  )
})

test('MCP names are humanised for display only', () => {
  expect(parseMcp('mcp__agentbase-local__list_agents')).toEqual({
    server: 'agentbase-local',
    tool: 'list_agents',
  })
  expect(parseMcp('mcp__ccd_session_mgmt__archive_session')?.server).toBe('ccd_session_mgmt')
  expect(parseMcp('mcp__')).toBeNull()
  expect(parseMcp('mcp____x')).toBeNull()
  expect(humanName('mcp__claude_ai_agentbase__run_agent')).toBe('agentbase · run agent')
  expect(humanName('__proto__')).not.toBe('')
  expect(humanName('x'.repeat(500)).length).toBeLessThanOrEqual(60)
})

test.each(['constructor', '__proto__', 'toString', ''])(
  'a call named %j is drawn generically',
  (name) => {
    const { card } = mount(tool(name, { query: 'q' }, { text: 'hello' }))
    expect(card).toHaveAttribute('data-chat-state', 'done')
    expect(card.textContent).toContain('q')
  },
)

// ── Fallbacks ────────────────────────────────────────────────────────────────

test('a renderer that answers null falls back to the raw call', async () => {
  const user = userEvent.setup()
  // Read without a path is not shaped as Read expects.
  const { card, toggle } = mount(tool('Read', { weird: 1 }, { text: 'plain result text' }))
  expect(within(card).getByText('Read')).toBeInTheDocument()
  await user.click(toggle!)
  expect(within(body(card)!).getByText('plain result text')).toBeInTheDocument()
  expect(body(card)!.textContent).toContain('"weird": 1')
})

test('a renderer that throws falls back to the raw call', async () => {
  const user = userEvent.setup()
  registry.override = () => {
    throw new Error('renderer bug')
  }
  const { card, toggle } = mount(tool('Bash', { command: 'ls' }, { text: 'raw result' }))
  expect(card).toHaveAttribute('data-chat-tool', 'Bash')
  await user.click(toggle!)
  expect(body(card)!.textContent).toContain('raw result')
})

test('a body that throws as it is drawn is replaced by the raw call', async () => {
  const user = userEvent.setup()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const Boom = (): React.JSX.Element => {
    throw new Error('body bug')
  }
  registry.override = () => ({
    label: 'Custom',
    icon: (() => null) as never,
    summary: 's',
    body: <Boom />,
  })
  const again = mount(tool('Bash', { command: 'ls' }, { text: 'still shown' }))
  await user.click(again.toggle!)
  expect(body(again.card)!.textContent).toContain('still shown')
})

// ── Families: well-formed ────────────────────────────────────────────────────

interface Family {
  name: string
  item: ToolItem
  /** On the collapsed row. */
  row: string
  /** Once opened. */
  opened: string
}

const PATCH = [
  {
    oldStart: 3,
    oldLines: 2,
    newStart: 3,
    newLines: 2,
    lines: [' keep', '-old line', '+new line'],
  },
]

const families: Family[] = [
  {
    name: 'Bash',
    item: tool(
      'Bash',
      { command: 'ls -la', description: 'List files' },
      { text: 'a.txt\nb.txt', data: { stdout: 'a.txt\nb.txt', stderr: 'warn: x' } },
    ),
    row: 'List files',
    opened: 'warn: x',
  },
  {
    name: 'Read',
    item: tool(
      'Read',
      { file_path: '/src/app/main.ts', offset: 5, limit: 2 },
      { text: '5\tconst a = 1\n6\tconst b = 2' },
    ),
    row: 'main.ts',
    opened: 'const b = 2',
  },
  {
    name: 'Edit',
    item: tool(
      'Edit',
      { file_path: '/src/a.ts', old_string: 'old line', new_string: 'new line' },
      { text: 'updated', data: { structuredPatch: PATCH } },
    ),
    row: 'a.ts',
    opened: 'new line',
  },
  {
    name: 'Write',
    item: tool(
      'Write',
      { file_path: '/src/new.ts', content: 'export const x = 1\n' },
      { text: 'File created successfully at: /src/new.ts' },
    ),
    row: 'new.ts',
    opened: 'export const x = 1',
  },
  {
    name: 'Grep',
    item: tool('Grep', { pattern: 'TODO', path: '/src' }, { text: 'src/a.ts\nsrc/b.ts' }),
    row: 'TODO',
    opened: 'src/b.ts',
  },
  {
    name: 'Glob',
    item: tool('Glob', { pattern: '**/*.tsx' }, { text: 'a/B.tsx' }),
    row: '**/*.tsx',
    opened: 'a/B.tsx',
  },
  {
    name: 'WebFetch',
    item: tool(
      'WebFetch',
      { url: 'https://example.com/docs', prompt: 'summarise' },
      { text: 'The **answer**', data: { code: 200, bytes: 2048 } },
    ),
    row: 'example.com/docs',
    opened: 'answer',
  },
  {
    name: 'WebSearch',
    item: tool(
      'WebSearch',
      { query: 'holi app' },
      {
        text: 'results',
        data: {
          results: [
            { tool_use_id: 'x', content: [{ title: 'Holi home', url: 'https://holi.dev/a' }] },
            'commentary here',
          ],
        },
      },
    ),
    row: 'holi app',
    opened: 'Holi home',
  },
  {
    name: 'Agent',
    item: tool(
      'Agent',
      { description: 'Explore the repo', prompt: 'Look around', subagent_type: 'Explore' },
      {
        text: 'Async agent launched successfully. agentId: abc123',
        data: { status: 'async_launched', agentId: 'abc123' },
      },
    ),
    row: 'Explore the repo',
    opened: 'Prompt',
  },
  {
    name: 'SendMessage',
    item: tool('SendMessage', { to: 'worker', message: 'please **stop**' }, { text: '{}' }),
    row: 'worker',
    opened: 'stop',
  },
  {
    name: 'SubagentHandback',
    item: tool('SubagentHandback', { message: 'Report: done' }, { text: '{}' }),
    row: 'Report: done',
    opened: 'Report: done',
  },
  {
    name: 'TaskCreate',
    item: tool(
      'TaskCreate',
      { subject: 'Write tests', description: 'cover all' },
      { text: 'Task #4 created successfully', data: { task: { id: '4', subject: 'Write tests' } } },
    ),
    row: 'Write tests',
    opened: 'cover all',
  },
  {
    name: 'TaskUpdate',
    item: tool(
      'TaskUpdate',
      { taskId: '4', status: 'completed', description: 'all covered' },
      { text: 'Updated', data: { statusChange: { from: 'in_progress', to: 'completed' } } },
    ),
    row: 'Task #4',
    opened: 'all covered',
  },
  {
    name: 'TodoWrite',
    item: tool(
      'TodoWrite',
      {
        todos: [
          { content: 'First', status: 'completed', activeForm: 'Firsting' },
          { content: 'Second', status: 'in_progress', activeForm: 'Seconding' },
        ],
      },
      { text: 'ok' },
    ),
    row: 'Seconding',
    opened: 'First',
  },
  {
    name: 'AskUserQuestion',
    item: tool(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which colour?',
            header: 'Colour',
            multiSelect: false,
            options: [
              { label: 'Red', description: 'warm' },
              { label: 'Blue', description: 'cool' },
            ],
          },
        ],
      },
      {
        text: 'User has answered your questions: "Which colour?"="Blue"',
        data: { answers: { 'Which colour?': 'Blue' } },
      },
    ),
    row: 'Which colour? → Blue',
    opened: 'Red',
  },
  {
    name: 'ExitPlanMode',
    item: tool('ExitPlanMode', { plan: '# The plan\n\nDo the thing.' }, { text: 'approved' }),
    row: 'The plan',
    opened: 'Do the thing.',
  },
  {
    name: 'Skill',
    item: tool('Skill', { skill: 'vault-apps', args: '--fast' }, { text: 'Launching skill' }),
    row: 'vault-apps',
    opened: '--fast',
  },
  {
    name: 'Monitor',
    item: tool(
      'Monitor',
      { command: 'tail -f log', description: 'Watch the log', persistent: 'false' },
      { text: 'Monitor started (task b1, expires in 5m)', data: { taskId: 'b1' } },
    ),
    row: 'Watch the log',
    opened: 'tail -f log',
  },
  {
    name: 'Workflow',
    item: tool(
      'Workflow',
      { script: 'step one\nstep two' },
      {
        text: 'started',
        data: { workflowName: 'nightly', taskId: 'w1', status: 'async_launched' },
      },
    ),
    row: 'nightly',
    opened: 'step two',
  },
  {
    name: 'TaskStop',
    item: tool(
      'TaskStop',
      { task_id: 'b1' },
      {
        text: '{"message":"stopped","task_id":"b1","task_type":"monitor","command":"tail -f log"}',
      },
    ),
    row: 'tail -f log',
    opened: 'tail -f log',
  },
  {
    name: 'ToolSearch',
    item: tool(
      'ToolSearch',
      { query: 'select:Read,Edit' },
      { text: '', data: { matches: ['Read', 'Edit'] } },
    ),
    row: '2 tools',
    opened: 'Edit',
  },
  {
    name: 'mcp',
    item: tool(
      'mcp__agentbase-local__list_agents',
      { team: 'core' },
      { text: '{"agents":[{"name":"ada"}]}' },
    ),
    row: 'core',
    opened: 'agents',
  },
  {
    name: 'browser',
    item: tool(
      'mcp__Claude_Browser__navigate',
      { url: 'https://example.com' },
      { text: 'navigated', images: [{ mediaType: 'image/png', bytes: 245_760 }] },
    ),
    row: 'https://example.com',
    opened: 'Image · 240 KB',
  },
  {
    name: 'generic',
    item: tool(
      'SomethingNew',
      { title: 'hello' },
      { text: 'its result', images: [{ mediaType: 'image/png', bytes: 2048 }] },
    ),
    row: 'hello',
    opened: 'its result',
  },
]

test.each(families)('$name: a well-formed call draws, opens and closes', async (family) => {
  const user = userEvent.setup()
  const { card, toggle } = mount(family.item)
  expect(card).toHaveAttribute('data-chat-tool', family.item.name)
  expect(card.textContent).toContain(family.row)
  expect(toggle).not.toBeNull()
  if (toggle!.getAttribute('aria-expanded') === 'true') await user.click(toggle!)
  toggle!.focus()
  await user.keyboard('{Enter}')
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(body(card)).not.toBeNull()
  expect(body(card)!.textContent).toContain(family.opened)
  await user.keyboard('{Enter}')
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

// ── Families: malformed ──────────────────────────────────────────────────────

const HUGE = 'z'.repeat(120_000)
const WRONG_ARGS: unknown[] = [
  {},
  null,
  [],
  'a string',
  42,
  { file_path: 12, command: ['a'], pattern: {}, url: true, query: null, prompt: [] },
  { file_path: HUGE, command: HUGE, old_string: HUGE, new_string: HUGE, content: HUGE, plan: HUGE },
  { todos: 'nope', questions: 'nope', plan: 5, subject: [], skill: {}, task_id: [], taskId: {} },
  { todos: [null, 3, { content: 5 }], questions: [null, { question: 7, options: 'x' }] },
]
const WRONG_RESULTS: unknown[] = [
  undefined,
  null,
  { ok: true, text: 42 },
  { ok: false, text: null },
  { ok: true, text: HUGE },
  { ok: false, text: HUGE },
  { ok: true, text: '', data: 'not a record' },
  {
    ok: true,
    text: 'x',
    data: {
      stdout: 5,
      stderr: [],
      structuredPatch: 'x',
      answers: 3,
      results: 'x',
      file: 7,
      code: 'abc',
      task: [],
      matches: 'a',
      content: 4,
    },
  },
  {
    ok: true,
    text: 'x',
    data: {
      structuredPatch: [{ lines: [1, 2] }, null, { lines: ['+a'] }],
      results: [null, 1, { content: 'x' }, { content: [null, { url: 5 }] }],
    },
  },
  { ok: true, text: 'x', images: 'many' },
  { ok: true, text: 'x', images: [null, { bytes: 'big' }, { mediaType: 5, bytes: -1 }] },
]
const NAMES = [
  ...families.map((f) => f.item.name),
  'constructor',
  '__proto__',
  'mcp__',
  'mcp__a__',
  'mcp____',
  'mcp__Claude_Browser__browser_batch',
  'Task',
  'bash',
]

test('malformed calls never throw, in any family', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const thrown: string[] = []
  for (const name of NAMES) {
    for (const args of WRONG_ARGS) {
      for (const result of WRONG_RESULTS) {
        const state: unknown = result === undefined ? 'pending' : 'done'
        const item = broken({ kind: 'tool', id: 'm', name, summary: 5, args, result, state })
        try {
          const { toggle, unmount } = mount(item)
          if (toggle !== null && toggle.getAttribute('aria-expanded') !== 'true') {
            fireEvent.click(toggle)
          }
          unmount()
        } catch (error) {
          thrown.push(`${name}: ${String(error)}`)
        }
      }
    }
  }
  expect(thrown).toEqual([])
}, 120_000)

test('wrong-typed names and a missing item do not throw', () => {
  for (const name of [5, null, undefined, {}, ['x']]) {
    expect(() =>
      mount(broken({ kind: 'tool', id: 'n', name, args: {}, state: 'done' })),
    ).not.toThrow()
  }
})

test('malformed ask, plan and todos fall back to the raw call', async () => {
  const user = userEvent.setup()
  for (const item of [
    tool('AskUserQuestion', { questions: 'nope' }, { text: 'User has answered' }),
    tool('ExitPlanMode', { plan: 5 }, { text: 'approved text' }),
    tool('TodoWrite', { todos: 'nope' }, { text: 'ok' }),
  ]) {
    const { card, toggle, unmount } = mount(item)
    await user.click(toggle!)
    expect(card.textContent).toContain(item.name)
    unmount()
  }
})

// ── Behaviour of particular families ────────────────────────────────────────

test('Edit: a diff from the structured patch, with its churn and gutters', async () => {
  const user = userEvent.setup()
  const { card, toggle } = mount(families.find((f) => f.name === 'Edit')!.item)
  expect(within(card).getByText('+1')).toBeInTheDocument()
  expect(within(card).getByText('−1')).toBeInTheDocument()
  await user.click(toggle!)
  const added = card.querySelector('[data-diff-line="add"]')!
  const removed = card.querySelector('[data-diff-line="del"]')!
  expect(added.textContent).toContain('new line')
  expect(removed.textContent).toContain('old line')
  // Backgrounds, never edges.
  expect(added.className).toMatch(/bg-\(--diff-added\)/)
  expect(added.className).not.toMatch(/border|ring|outline/)
  // Hunk numbering: the removed line is old line 4, the added new line 4.
  expect(removed.textContent).toContain('4')
})

test('Edit: without a structured result the diff is built from the call', async () => {
  const user = userEvent.setup()
  const { card, toggle } = mount(
    tool(
      'Edit',
      { file_path: '/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' },
      { text: 'updated' },
    ),
  )
  expect(within(card).getByText('+2')).toBeInTheDocument()
  await user.click(toggle!)
  expect(card.querySelectorAll('[data-diff-line="add"]')).toHaveLength(2)
  expect(card.querySelectorAll('[data-diff-line="del"]')).toHaveLength(1)
})

test('a diff of hundreds of lines is clipped, and Show all shows the rest', async () => {
  const user = userEvent.setup()
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
  const { card, toggle } = mount(
    tool('Edit', { file_path: '/a.ts', old_string: '', new_string: lines }, { text: 'updated' }),
  )
  await user.click(toggle!)
  expect(card.querySelectorAll('[data-diff-line]')).toHaveLength(150)
  await user.click(within(card).getByRole('button', { name: /Show all/ }))
  expect(card.querySelectorAll('[data-diff-line]')).toHaveLength(400)
})

test('diff models: patches, strings, and values that are neither', () => {
  expect(diffFromPatch('x')).toBeNull()
  expect(diffFromPatch([{ lines: [1] }])).toBeNull()
  expect(diffFromPatch([])).toBeNull()
  const m = diffFromPatch(PATCH)!
  expect([m.added, m.removed, m.numbered]).toEqual([1, 1, true])
  const s = diffFromStrings('same\nold\nsame2', 'same\nnew\nsame2')
  expect([s.added, s.removed]).toEqual([1, 1])
  expect(diffFromStrings('', '').lines).toEqual([])
})

test('Bash: the output is the structured stdout, the failure is its exit code', async () => {
  const user = userEvent.setup()
  const ok = mount(families[0]!.item)
  await user.click(ok.toggle!)
  expect(within(ok.card).getByText('warn: x')).toBeInTheDocument()
  ok.unmount()
  // Only the flattened text exists on failure: "Exit code N" is parsed off.
  const bad = mount(
    tool('Bash', { command: 'make' }, { ok: false, text: 'Exit code 7\nlink failed' }),
  )
  expect(within(bad.card).getByText('exit 7')).toBeInTheDocument()
  expect(bad.card.textContent).toContain('link failed')
  expect(bad.card.textContent).not.toContain('Exit code 7')
})

test('Read: the numbered prefixes become a gutter', async () => {
  const user = userEvent.setup()
  const { card, toggle } = mount(families[1]!.item)
  await user.click(toggle!)
  expect(card.textContent).toContain('const a = 1')
  expect(card.textContent).not.toContain('5\tconst')
  expect(within(card).getByText('lines 5–6')).toBeInTheDocument()
})

test('a result of hundreds of kilobytes is clipped, with Show all', async () => {
  const user = userEvent.setup()
  const { card, toggle } = mount(tool('SomethingNew', { a: 1 }, { text: HUGE }))
  await user.click(toggle!)
  expect(card.textContent!.length).toBeLessThan(10_000)
  await user.click(within(card).getByRole('button', { name: /Show all/ }))
  expect(card.textContent!.length).toBeGreaterThan(20_000)
  expect(card.textContent!.length).toBeLessThan(60_000)
})

test('clip cuts by lines and by characters and says how much is left', () => {
  expect(clip('a\nb\nc\nd', 2, 100)).toMatchObject({ text: 'a\nb', clipped: true, moreLines: 2 })
  expect(clip('abcdef', 10, 3)).toMatchObject({ text: 'abc', clipped: true })
  expect(clip('abc', 10, 100)).toMatchObject({ text: 'abc', clipped: false })
  expect(clip(5 as unknown as string, 2, 2).text).toBe('')
  // Not through the middle of a surrogate pair.
  expect(clip('a😀', 5, 2).text).toBe('a')
})

test('the generic view lists images as chips and never their bytes', async () => {
  const user = userEvent.setup()
  const { card, toggle } = mount(families.at(-1)!.item)
  await user.click(toggle!)
  expect(within(card).getByText('Image · 2 KB')).toBeInTheDocument()
  const clippedCall = mount(tool('SomethingNew', { a: 1 }, { text: 'x' }, { clipped: true }))
  await user.click(clippedCall.toggle!)
  expect(clippedCall.card.textContent).toContain('shortened')
})

test('MCP: JSON text opens as a tree and a binary input is never shown', async () => {
  const user = userEvent.setup()
  const { card, toggle } = mount(
    tool(
      'mcp__agentbase-local__attach_file',
      { name: 'report.pdf', content_base64: 'QUJD'.repeat(3000) },
      { text: '{"ok":true,"node":{"id":"n1"}}' },
    ),
  )
  expect(card.textContent).toContain('agentbase-local · attach file')
  await user.click(toggle!)
  expect(card.querySelector('[data-chat-json]')).not.toBeNull()
  expect(card.textContent).toContain('"n1"')
  expect(card.textContent).not.toContain('QUJDQUJD')
  expect(card.textContent).toContain('report.pdf')
})

test('Tasks: the glyph follows the task list now, not the call', () => {
  const create = tool(
    'TaskCreate',
    { subject: 'Ship it' },
    { text: 'Task #9 created', data: { task: { id: '9' } } },
  )
  const first = mount(
    create,
    ctx({ tasks: new Map([['9', { id: '9', subject: 'Ship it', status: 'pending' }]]) }),
  )
  expect(first.card.textContent).not.toContain('done')
  first.rerender(
    <ToolCard
      item={create}
      ctx={ctx({ tasks: new Map([['9', { id: '9', subject: 'Ship it', status: 'completed' }]]) })}
    />,
  )
  expect(within(first.card).getByText('done')).toBeInTheDocument()
  expect(first.card.querySelector('.text-task-done')).not.toBeNull()
})

test('Tasks: an update shows the subject the list knows for the id', () => {
  const update = tool('TaskUpdate', { taskId: '3', status: 'in_progress' }, { text: 'Updated' })
  const { card } = mount(
    update,
    ctx({ tasks: new Map([['3', { id: '3', subject: 'Refactor', status: 'in_progress' }]]) }),
  )
  expect(card.textContent).toContain('Refactor')
  expect(card.querySelector('.text-task-doing')).not.toBeNull()
})

test('AskUserQuestion: the chosen answer is highlighted by background, a dismissal is not', async () => {
  const user = userEvent.setup()
  const answered = mount(families.find((f) => f.name === 'AskUserQuestion')!.item)
  await user.click(answered.toggle!)
  const chosen = answered.card.querySelectorAll('[data-chosen]')
  expect(chosen).toHaveLength(1)
  expect(chosen[0]!.textContent).toContain('Blue')
  expect(chosen[0]!.className).toMatch(/bg-accent/)
  expect(chosen[0]!.className).not.toMatch(/border|ring|outline/)
  answered.unmount()

  const dismissed = mount(
    tool(
      'AskUserQuestion',
      {
        questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }],
      },
      { ok: false, text: "The user doesn't want to proceed" },
      { state: 'rejected' },
    ),
  )
  expect(within(dismissed.card).getByText('dismissed')).toBeInTheDocument()
  await user.click(dismissed.toggle!)
  expect(dismissed.card.querySelectorAll('[data-chosen]')).toHaveLength(0)
})

test('AskUserQuestion: answers keyed by a hostile question text are read as own properties', async () => {
  const user = userEvent.setup()
  const { card, toggle } = mount(
    tool(
      'AskUserQuestion',
      { questions: [{ question: 'constructor', options: [{ label: 'A' }] }] },
      { text: '', data: { answers: {} } },
    ),
  )
  await user.click(toggle!)
  expect(card.querySelectorAll('[data-chosen]')).toHaveLength(0)
})

test('AskUserQuestion: with no structured answers they are read from the text', async () => {
  const user = userEvent.setup()
  const { card, toggle } = mount(
    tool(
      'AskUserQuestion',
      { questions: [{ question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] }] },
      { text: 'User has answered your questions: "Which?"="Two". You can now continue' },
    ),
  )
  await user.click(toggle!)
  expect(card.querySelector('[data-chosen]')!.textContent).toContain('Two')
})

test('ExitPlanMode: approved, rejected and awaiting are different chips', () => {
  const plan = { plan: '# P\n\nbody' }
  const approved = mount(tool('ExitPlanMode', plan, { text: 'ok' }))
  expect(within(approved.card).getByText('approved')).toBeInTheDocument()
  approved.unmount()
  const rejected = mount(
    tool('ExitPlanMode', plan, { ok: false, text: 'no' }, { state: 'rejected' }),
  )
  expect(rejected.card).toHaveAttribute('data-chat-state', 'rejected')
  expect(within(rejected.card).getByText('rejected')).toBeInTheDocument()
  rejected.unmount()
  const waiting = mount(tool('ExitPlanMode', plan))
  expect(within(waiting.card).getByText('awaiting approval')).toBeInTheDocument()
})

test('Agent: the state comes from the note, not from the launch acknowledgement', () => {
  const launched = tool(
    'Agent',
    { description: 'Dig', prompt: 'p' },
    {
      text: 'Async agent launched successfully',
      data: { status: 'async_launched', agentId: 'a1' },
    },
  )
  const running = mount(launched)
  expect(within(running.card).getByText('running')).toBeInTheDocument()
  // Pulsing though the call has its result: the work goes on.
  expect(running.card.querySelector('.motion-pulse')).not.toBeNull()
  running.unmount()
  const completed = mount({
    ...launched,
    note: {
      kind: 'task-note',
      id: 'n',
      toolUseId: launched.id,
      status: 'completed',
      summary: 'Found 3 things',
    },
  })
  expect(within(completed.card).getByText('completed')).toBeInTheDocument()
  expect(completed.card.querySelector('.motion-pulse')).toBeNull()
  completed.unmount()
  const failed = mount({
    ...launched,
    note: {
      kind: 'task-note',
      id: 'n',
      toolUseId: launched.id,
      status: 'failed',
      summary: 'crashed',
    },
  })
  expect(within(failed.card).getByText('failed')).toBeInTheDocument()
})

test('Agent: opening it reads the sub-agent conversation, nested', async () => {
  const user = userEvent.setup()
  const sub: ChatItem[] = [{ kind: 'user', id: 'u1', text: 'nested hello' }]
  const loadSubagent = vi.fn().mockResolvedValue(sub)
  const { card, toggle } = mount(
    families.find((f) => f.name === 'Agent')!.item,
    ctx({ loadSubagent }),
  )
  expect(loadSubagent).not.toHaveBeenCalled()
  await user.click(toggle!)
  expect(await within(card).findByText('nested hello')).toBeInTheDocument()
  expect(loadSubagent).toHaveBeenCalledWith('abc123')
  expect(card.querySelector('[data-chat-depth="1"]')).not.toBeNull()
})

test.each([
  ['an empty conversation', () => Promise.resolve([] as ChatItem[]), 'Nothing recorded'],
  ['an unreadable one', () => Promise.resolve(null), 'could not be read'],
  ['a failing read', () => Promise.reject(new Error('disk')), 'could not be read'],
])('Agent: %s says so', async (_name, load, text) => {
  const user = userEvent.setup()
  const { card, toggle } = mount(
    families.find((f) => f.name === 'Agent')!.item,
    ctx({ loadSubagent: load }),
  )
  await user.click(toggle!)
  expect(await within(card).findByText(new RegExp(text))).toBeInTheDocument()
})

test('Agent: the prompt is behind its own disclosure', async () => {
  const user = userEvent.setup()
  const { card, toggle } = mount(families.find((f) => f.name === 'Agent')!.item)
  await user.click(toggle!)
  expect(card.textContent).not.toContain('Look around')
  await user.click(within(card).getByRole('button', { name: 'Prompt' }))
  expect(card.textContent).toContain('Look around')
})

test('Agent: a thread that resolves after the card closed does not update it', async () => {
  const user = userEvent.setup()
  let release: (items: ChatItem[]) => void = () => undefined
  const pending = new Promise<ChatItem[]>((resolve) => {
    release = resolve
  })
  const { toggle } = mount(
    families.find((f) => f.name === 'Agent')!.item,
    ctx({ loadSubagent: () => pending }),
  )
  await user.click(toggle!)
  await user.click(toggle!)
  await waitFor(() => expect(screen.queryByText('Prompt')).toBeNull())
  await act(async () => release([{ kind: 'user', id: 'x', text: 'late' }]))
  expect(screen.queryByText('late')).toBeNull()
})

test('WebFetch: a 404 that Claude Code did not call an error still reads as one', () => {
  const { card } = mount(
    tool(
      'WebFetch',
      { url: 'https://example.com/x' },
      { text: 'The server returned HTTP 404 for it' },
    ),
  )
  expect(within(card).getByText('HTTP 404')).toBeInTheDocument()
})

test('chips beyond three go to the top of the body', async () => {
  const user = userEvent.setup()
  const { card, toggle } = mount(
    tool(
      'Agent',
      { description: 'd', subagent_type: 'Explore' },
      {
        text: 'done',
        data: {
          totalToolUseCount: 4,
          totalTokens: 12_000,
          totalDurationMs: 3000,
          resolvedModel: 'opus',
        },
      },
    ),
  )
  const row = toggle!
  expect(row.querySelectorAll('[data-chat-chip]')).toHaveLength(3)
  await user.click(toggle!)
  expect(body(card)!.querySelectorAll('[data-chat-chip]').length).toBeGreaterThan(0)
})

beforeEach(() => {
  registry.override = null
})
