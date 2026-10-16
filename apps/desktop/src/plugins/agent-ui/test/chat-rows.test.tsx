/**
 * How the chat draws a conversation's items: one row per kind, each in its
 * own boundary, and the markdown of an assistant message.
 */
import { render, screen, within } from '@/test/render'
import { act, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ChatContext, ChatItem } from '../../agent/renderer/chat/items'
import { ChatMarkdown, chatMarkdownBlocks } from '../renderer/chat/ChatMarkdown'
import { ItemRow } from '../renderer/chat/rows/ItemRow'
import { RowBoundary, resetRowErrors, rowErrorsOf } from '../renderer/chat/rows/RowBoundary'

// A tool's card is its own subject (`ToolCard`'s tests).
vi.mock('../renderer/chat/rows/ToolCard', () => ({
  ToolCard: ({ item }: { item: { name: string } }) => (
    <div data-chat-row="tool">{`tool:${item.name}`}</div>
  ),
}))

const ctx: ChatContext = { tasks: new Map(), loadSubagent: async () => null, sessionId: 's1' }

const row = (item: ChatItem, props: Partial<React.ComponentProps<typeof ItemRow>> = {}) =>
  render(<ItemRow item={item} ctx={ctx} {...props} />)
const rowOf = (kind: string) => document.querySelector(`[data-chat-row="${kind}"]`)

const written: string[] = []
beforeEach(() => {
  written.length = 0
  resetRowErrors()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        written.push(text)
        return Promise.resolve()
      },
    },
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// A throw in a row is logged by React and by jsdom; the tests expect it.
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

test('a person, the agent, a tool', () => {
  row({ kind: 'user', id: 'u', text: 'Book the flights' })
  expect(screen.getByText('Book the flights')).toBeInTheDocument()
  expect(document.querySelector('[data-chat-user]')).not.toBeNull()
  row({ kind: 'assistant', id: 'a', text: 'On it, **looking** now.' })
  expect(screen.getByText('looking').tagName).toBe('STRONG')
  row({ kind: 'tool', id: 't', name: 'Bash', summary: 'ls', args: {}, state: 'done' })
  expect(screen.getByText('tool:Bash')).toBeInTheDocument()
})

test('a queued message says so, one that is not does not', () => {
  const { unmount } = row({ kind: 'user', id: 'u', text: 'later', queued: true })
  expect(document.querySelector('[data-chat-queued]')).toHaveTextContent('queued')
  unmount()
  row({ kind: 'user', id: 'u', text: 'now' })
  expect(document.querySelector('[data-chat-queued]')).toBeNull()
})

test('a thought is a closed disclosure that opens on a click', () => {
  row({ kind: 'thinking', id: 'k', text: 'Weighing **two** options' })
  expect(screen.queryByText('two')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Thought' }))
  expect(screen.getByText('two')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Thought' }))
  expect(screen.queryByText('two')).toBeNull()
})

test('an empty thought is not drawn', () => {
  row({ kind: 'thinking', id: 'k', text: '  \n ' })
  expect(rowOf('thinking')).toBeNull()
  expect(rowOf('error')).toBeNull()
})

test('a thought is open while it is the live row and closes a second after the next arrives', () => {
  vi.useFakeTimers()
  const item: ChatItem = { kind: 'thinking', id: 'k', text: 'Weighing options' }
  const { rerender } = render(<ItemRow item={item} ctx={ctx} live />)
  expect(screen.getByText('Weighing options')).toBeInTheDocument()
  rerender(<ItemRow item={item} ctx={ctx} live={false} />)
  act(() => void vi.advanceTimersByTime(900))
  expect(screen.getByText('Weighing options')).toBeInTheDocument()
  act(() => void vi.advanceTimersByTime(200))
  expect(screen.queryByText('Weighing options')).toBeNull()
})

test('a thought the person opened stays open', () => {
  vi.useFakeTimers()
  const item: ChatItem = { kind: 'thinking', id: 'k', text: 'Weighing options' }
  const { rerender } = render(<ItemRow item={item} ctx={ctx} live={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Thought' }))
  rerender(<ItemRow item={item} ctx={ctx} live />)
  rerender(<ItemRow item={item} ctx={ctx} live={false} />)
  act(() => void vi.advanceTimersByTime(3000))
  expect(screen.getByText('Weighing options')).toBeInTheDocument()
})

test('a slash command is a chip and its words', () => {
  row({ kind: 'command', id: 'c', name: '/model', args: 'opus' })
  const chip = rowOf('command')!
  expect(chip).toHaveTextContent('/model')
  expect(chip).toHaveTextContent('opus')
  row({ kind: 'command', id: 'c2', name: 'compact', args: '' })
  expect(screen.getByText('/compact')).toBeInTheDocument()
})

test('a shell command keeps its output behind a disclosure', () => {
  row({ kind: 'shell', id: 's', command: 'ls -la', stdout: 'file-a\nfile-b', stderr: 'warn: x' })
  expect(screen.getByText('ls -la')).toBeInTheDocument()
  expect(screen.queryByText(/file-a/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Output' }))
  expect(screen.getByText(/file-a/)).toBeInTheDocument()
  expect(screen.getByText('warn: x')).toBeInTheDocument()
})

test('a shell command with no output has no disclosure', () => {
  row({ kind: 'shell', id: 's', command: 'true' })
  expect(screen.queryByRole('button', { name: 'Output' })).toBeNull()
})

test('an interrupt says what it interrupted', () => {
  row({ kind: 'interrupt', id: 'i', forTool: false })
  expect(screen.getByText('Interrupted')).toBeInTheDocument()
  row({ kind: 'interrupt', id: 'i2', forTool: true })
  expect(screen.getByText('Interrupted during a tool call')).toBeInTheDocument()
})

test('a notice is plain text in its tone, its detail behind a disclosure', () => {
  row({
    kind: 'notice',
    id: 'n',
    source: 'compact-summary',
    tone: 'warn',
    text: 'Context is almost full',
    detail: 'The summary of what came before',
  })
  const notice = rowOf('notice')!
  expect(notice).toHaveAttribute('data-tone', 'warn')
  expect(notice).toHaveClass('text-[var(--context-warm)]')
  expect(screen.queryByText(/The summary/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  expect(screen.getByText(/The summary/)).toBeInTheDocument()
})

test('an error notice is in the destructive colour, a tone it does not know is info', () => {
  row({ kind: 'notice', id: 'n', source: 'api-error', tone: 'error', text: 'Overloaded' })
  expect(rowOf('notice')).toHaveClass('text-destructive')
  row({ kind: 'notice', id: 'n2', source: 'info', tone: 'loud' as 'info', text: 'Odd' })
  expect(screen.getByText('Odd').closest('[data-chat-row]')).toHaveClass('text-muted-foreground')
})

test('a compaction is a labelled divider with its token counts', () => {
  row({ kind: 'compaction', id: 'p', preTokens: 168_000, postTokens: 24_500 })
  expect(rowOf('compaction')).toHaveTextContent('Conversation compacted · 168k → 24.5k tokens')
})

test('a compaction without counts is still a divider', () => {
  row({ kind: 'compaction', id: 'p' })
  expect(rowOf('compaction')).toHaveTextContent(/^Conversation compacted$/)
})

test('the end of a turn says how long it took', () => {
  row({ kind: 'turn-end', id: 'e', durationMs: 12_400 })
  expect(screen.getByText('Worked for 12s')).toBeInTheDocument()
  row({ kind: 'turn-end', id: 'e2', durationMs: 75_000 })
  expect(screen.getByText('Worked for 1m 15s')).toBeInTheDocument()
})

test('a background task is a slim status row', () => {
  row({ kind: 'task-note', id: 'k', status: 'completed', summary: 'Indexed 40 files' })
  expect(rowOf('task-note')).toHaveTextContent('Background task completed')
  expect(rowOf('task-note')).toHaveTextContent('Indexed 40 files')
})

test('a line this build has no rule for is shown with what it was', () => {
  row({ kind: 'unknown', id: 'x', shape: 'system:new-thing{a,b}', raw: '{"a":1}', version: '9.9' })
  expect(screen.getByText('Unrecognised: system:new-thing{a,b}')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Show what it was' }))
  expect(screen.getByText('{"a":1}')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  expect(written).toEqual(['{"a":1}'])
})

test('a kind this build does not know is drawn as unrecognised, not dropped', () => {
  row({ kind: 'hologram', id: 'h', glow: 3 } as unknown as ChatItem)
  expect(screen.getByText('Unrecognised: kind:hologram')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Show what it was' }))
  expect(screen.getByText(/"glow": 3/)).toBeInTheDocument()
})

test('a nested row is indented and smaller', () => {
  row({ kind: 'turn-end', id: 'e', durationMs: 1000 }, { depth: 1 })
  expect(document.querySelector('[data-chat-depth="1"]')).not.toBeNull()
})

test('a field of the wrong type in a notice is tolerated, not fatal', () => {
  render(
    <>
      <ItemRow item={{ kind: 'user', id: 'u', text: 'before' }} ctx={ctx} />
      <ItemRow
        item={{ kind: 'notice', id: 'n', source: 'info', tone: 'info', text: { oops: 1 } as never }}
        ctx={ctx}
      />
      <ItemRow item={{ kind: 'assistant', id: 'a', text: 'after' }} ctx={ctx} />
    </>,
  )
  expect(screen.getByText('before')).toBeInTheDocument()
  expect(screen.getByText('after')).toBeInTheDocument()
  expect(rowOf('notice')).not.toBeNull()
  expect(rowOf('error')).toBeNull()
})

test('a row that throws is replaced by the fallback with its raw item, and the rest stay', () => {
  quiet()
  const bad = { kind: 'user', id: 'bad', text: 42 } as unknown as ChatItem
  const seen: string[] = []
  render(
    <>
      <ItemRow item={{ kind: 'assistant', id: 'a', text: 'before' }} ctx={ctx} />
      <ItemRow item={bad} ctx={ctx} onRowError={(shape) => seen.push(shape)} />
      <ItemRow item={{ kind: 'assistant', id: 'b', text: 'after' }} ctx={ctx} />
    </>,
  )
  expect(screen.getByText('before')).toBeInTheDocument()
  expect(screen.getByText('after')).toBeInTheDocument()
  const fallback = rowOf('error')!
  expect(fallback).toHaveTextContent('This part could not be shown')
  fireEvent.click(within(fallback as HTMLElement).getByRole('button', { name: 'Show what it was' }))
  expect(fallback).toHaveTextContent('"id": "bad"')
  fireEvent.click(within(fallback as HTMLElement).getByRole('button', { name: 'Copy' }))
  expect(JSON.parse(written[0]!)).toEqual({ kind: 'user', id: 'bad', text: 42 })
  expect(seen).toEqual(['row:user'])
  expect(rowErrorsOf('s1')).toEqual({ total: 1, shapes: [{ shape: 'row:user', count: 1 }] })
})

test('the boundary clips the raw item it shows to four kilobytes', () => {
  quiet()
  const Boom = (): never => {
    throw new Error('boom')
  }
  const big = { kind: 'x', id: 'big', blob: 'a'.repeat(10_000) }
  render(
    <RowBoundary item={big} scope="s2">
      <Boom />
    </RowBoundary>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Show what it was' }))
  const shown = document.querySelector('[data-chat-raw] pre')!.textContent!
  expect(shown.length).toBeLessThan(4_200)
  expect(shown).toContain('more characters')
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  expect(written[0]!.length).toBeGreaterThan(10_000)
})

test('a boundary draws again when its item changes', () => {
  quiet()
  const Maybe = ({ ok }: { ok: boolean }) => {
    if (!ok) throw new Error('not yet')
    return <p>drawn</p>
  }
  const first = { kind: 'assistant', id: 'a', v: 1 }
  const { rerender } = render(
    <RowBoundary item={first}>
      <Maybe ok={false} />
    </RowBoundary>,
  )
  expect(screen.getByText('This part could not be shown')).toBeInTheDocument()
  rerender(
    <RowBoundary item={{ ...first, v: 2 }}>
      <Maybe ok />
    </RowBoundary>,
  )
  expect(screen.getByText('drawn')).toBeInTheDocument()
})

test('an item that fails again is counted once', () => {
  quiet()
  const Boom = (): never => {
    throw new Error('boom')
  }
  const item = { kind: 'tool', id: 't', name: 'Mystery' }
  const { rerender } = render(
    <RowBoundary item={item} scope="s3">
      <Boom />
    </RowBoundary>,
  )
  rerender(
    <RowBoundary item={{ ...item }} scope="s3">
      <Boom />
    </RowBoundary>,
  )
  expect(rowErrorsOf('s3')).toEqual({ total: 1, shapes: [{ shape: 'row:tool:Mystery', count: 1 }] })
})

// ── ChatMarkdown ────────────────────────────────────────────────────────

const holi = { openExternal: vi.fn() }
beforeEach(() => {
  holi.openExternal.mockReset()
  ;(window as unknown as { holi: typeof holi }).holi = holi
})

test('every fenced code block has a Copy button that copies its code', async () => {
  render(<ChatMarkdown text={'Run:\n\n```sh\nnpm test\n```\n\nthen\n\n```\nsecond\n```'} />)
  const buttons = screen.getAllByRole('button', { name: 'Copy code' })
  expect(buttons).toHaveLength(2)
  fireEvent.click(buttons[0]!)
  await act(async () => {})
  expect(written).toEqual(['npm test\n'])
  expect(buttons[0]).toHaveTextContent('Copied')
})

test('a wide table and wide code scroll inside their own holders', () => {
  render(<ChatMarkdown text={'| a | b |\n| - | - |\n| 1 | 2 |\n\n```\nlong\n```'} />)
  expect(document.querySelector('.agent-chat-table > table')).not.toBeNull()
  expect(document.querySelector('.agent-chat-code > pre')).not.toBeNull()
})

test('an https link opens in the browser and the window does not navigate', () => {
  render(<ChatMarkdown text="See [the docs](https://example.com/a?b=1)." />)
  const event = fireEvent.click(screen.getByText('the docs'))
  expect(event).toBe(false) // default prevented
  expect(holi.openExternal).toHaveBeenCalledWith('https://example.com/a?b=1')
})

test('a mailto link opens too', () => {
  render(<ChatMarkdown text="Write to [me](mailto:me@example.com)." />)
  fireEvent.click(screen.getByText('me'))
  expect(holi.openExternal).toHaveBeenCalledWith('mailto:me@example.com')
})

test('javascript:, data:, file: and relative links are inert', () => {
  render(
    <ChatMarkdown
      text={[
        '[a](javascript:alert(1))',
        '[b](data:text/html;base64,PGgxPmhpPC9oMT4=)',
        '[c](file:///etc/passwd)',
        '[d](./local.md)',
        '[e](  JaVaScRiPt:alert(2))',
      ].join('\n\n')}
    />,
  )
  for (const label of ['a', 'b', 'c', 'd', 'e']) {
    const link = screen.getByText(label)
    expect(link.closest('a')?.hasAttribute('href') ?? false).toBe(false)
    fireEvent.click(link)
  }
  expect(holi.openExternal).not.toHaveBeenCalled()
})

test('a picture in the markdown is not fetched', () => {
  render(<ChatMarkdown text="![x](https://tracker.example/p.png?secret=1)" />)
  expect(document.querySelector('img')).toBeNull()
})

test('scripts and handlers in the markdown are removed', () => {
  render(<ChatMarkdown text={'<img src=x onerror="alert(1)"><script>alert(2)</script>ok'} />)
  expect(document.querySelector('script')).toBeNull()
  expect(document.querySelector('[onerror]')).toBeNull()
})

test('a growing message keeps the blocks it already drew', () => {
  const { rerender } = render(<ChatMarkdown text={'First paragraph.\n\nSecond'} />)
  const firstBlock = document.querySelector('.agent-chat-block')!
  const html = chatMarkdownBlocks('First paragraph.\n\nSecond')
  rerender(<ChatMarkdown text={'First paragraph.\n\nSecond one grew.\n\nThird'} />)
  expect(document.querySelector('.agent-chat-block')).toBe(firstBlock)
  expect(chatMarkdownBlocks('First paragraph.\n\nSecond one grew.\n\nThird')[0]).toBe(html[0])
  expect(document.querySelectorAll('.agent-chat-block')).toHaveLength(3)
  expect(screen.getByText('Second one grew.')).toBeInTheDocument()
})

test('a message with link definitions still resolves them', () => {
  render(<ChatMarkdown text={'See [docs][d].\n\n[d]: https://example.com/d'} />)
  fireEvent.click(screen.getByText('docs'))
  expect(holi.openExternal).toHaveBeenCalledWith('https://example.com/d')
})
