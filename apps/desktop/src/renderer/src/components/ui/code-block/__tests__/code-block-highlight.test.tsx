import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodeBlockHighlightOptions, CodeBlockLine } from '../code-block-highlight'

const { highlightCode } = vi.hoisted(() => ({ highlightCode: vi.fn() }))
vi.mock('../code-block-highlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../code-block-highlight')>()),
  highlightCode,
}))

import { CodeBlock, CodeBlockContent } from '../code-block'
import { render, screen, waitFor } from '@/test/render'

beforeEach(() => {
  highlightCode.mockReset()
})

describe('code block diff state', () => {
  it('renders diff state through CodeBlockContent and forwards it to the highlighter', async () => {
    highlightCode.mockImplementation(async (source: string, options: CodeBlockHighlightOptions) => {
      const added = new Set([...((options.diff?.added as number[]) ?? [])])
      const removed = new Set([...((options.diff?.removed as number[]) ?? [])])
      return source.split('\n').map((text, index) => {
        const line = index + 1
        const diff = added.has(line) ? 'add' : removed.has(line) ? 'remove' : undefined
        return {
          number: line,
          text,
          tokens: [{ content: text }],
          state: diff ? { diff } : undefined,
        }
      }) satisfies CodeBlockLine[]
    })

    render(
      <CodeBlock
        code={'before\nold\ncontext\nnew'}
        language="javascript"
        diff={{ removed: [2], added: [4] }}
      >
        <CodeBlockContent />
      </CodeBlock>,
    )

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="code-block-line"]')).toHaveLength(4),
    )
    const rows = Array.from(document.querySelectorAll('[data-slot="code-block-line"]'))
    expect(rows.map((row) => row.getAttribute('data-diff'))).toEqual([null, 'remove', null, 'add'])
    expect(rows.map((row) => row.textContent)).toEqual(['before', 'old', 'context', 'new'])
    expect(rows[1]?.className).toContain("data-[diff=remove]:after:content-['-']")
    expect(rows[3]?.className).toContain("data-[diff=add]:after:content-['+']")
    expect(highlightCode).toHaveBeenCalledWith(
      'before\nold\ncontext\nnew',
      expect.objectContaining({ diff: { removed: [2], added: [4] } }),
    )
  })

  it('ignores a stale highlight completion after the source changes', async () => {
    let resolveOld!: (lines: CodeBlockLine[]) => void
    highlightCode
      .mockReturnValueOnce(new Promise<CodeBlockLine[]>((resolve) => (resolveOld = resolve)))
      .mockImplementationOnce(async (source: string) => [
        { number: 1, text: source, tokens: [{ content: source }] },
      ])

    const view = render(
      <CodeBlock code="old source" language="javascript">
        <CodeBlockContent />
      </CodeBlock>,
    )
    view.rerender(
      <CodeBlock code="new source" language="javascript">
        <CodeBlockContent />
      </CodeBlock>,
    )

    await waitFor(() => expect(screen.getByText('new source')).toBeTruthy())
    resolveOld([{ number: 1, text: 'stale source', tokens: [{ content: 'stale source' }] }])
    await waitFor(() => expect(screen.queryByText('stale source')).toBeNull())
    expect(screen.getByText('new source')).toBeTruthy()
  })

  it.each([
    { language: 'not-a-real-grammar', highlight: true },
    { language: 'typescript', highlight: false },
  ])('renders markers without tokenizing $language (highlight=$highlight)', (props) => {
    const { container } = render(
      <CodeBlock code={'before\nold\ncontext\nnew'} {...props} diff={{ removed: [2], added: [4] }}>
        <CodeBlockContent />
      </CodeBlock>,
    )

    const lines = Array.from(container.querySelectorAll('[data-slot="code-block-line"]'))
    expect(lines.map((line) => line.getAttribute('data-diff'))).toEqual([null, 'remove', null, 'add'])
    expect(highlightCode).not.toHaveBeenCalled()
  })
})
