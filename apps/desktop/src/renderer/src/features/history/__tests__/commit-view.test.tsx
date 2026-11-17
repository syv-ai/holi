import { beforeEach, expect, it, vi } from 'vitest'

const { fileDiffQuery } = vi.hoisted(() => ({ fileDiffQuery: vi.fn() }))
vi.mock('@/lib/trpc', () => ({ trpc: { history: { fileDiff: { query: fileDiffQuery } } } }))

import { render, screen } from '@/test/render'
import { CommitView } from '../commit-view'

beforeEach(() => fileDiffQuery.mockReset())

it('renders added and removed diff rows through CommitView and CodeBlockContent', async () => {
  fileDiffQuery.mockResolvedValue({ before: 'before\nold\ncontext', after: 'before\nnew\ncontext' })
  const { container } = render(<CommitView path="notes/readme.txt" sha="abc1234" show="diff" />)

  const rows = await screen.findAllByText(/before|old|new|context/)
  expect(rows.length).toBeGreaterThan(0)
  const lines = Array.from(container.querySelectorAll('[data-slot="code-block-line"]'))
  expect(lines.map((line) => line.getAttribute('data-diff'))).toEqual([null, 'remove', 'add', null])
  expect(lines.map((line) => line.textContent)).toEqual(['before', 'old', 'new', 'context'])
})

it('retains diff markers when a known-language file exceeds the highlighting limit', async () => {
  const context = `// ${'x'.repeat(300_001)}`
  fileDiffQuery.mockResolvedValue({
    before: `${context}\nconst oldValue = 1`,
    after: `${context}\nconst newValue = 2`,
  })
  const { container } = render(<CommitView path="large.ts" sha="abc1234" show="diff" />)

  await screen.findByText('const newValue = 2')
  const lines = Array.from(container.querySelectorAll('[data-slot="code-block-line"]'))
  expect(lines.map((line) => line.getAttribute('data-diff'))).toEqual([null, 'remove', 'add'])
  expect(lines[0]?.textContent).toBe(context)
  expect(container.querySelector('[data-slot="code-block-token"]')).toBeNull()
})
