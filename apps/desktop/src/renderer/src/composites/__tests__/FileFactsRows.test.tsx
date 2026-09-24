import { render, screen } from '@/test/render'
import { expect, test, vi } from 'vitest'
import type { FileFacts } from '@/state/file-facts'
import { FileFactsRows } from '../FileFactsRows'

const { facts } = vi.hoisted(() => ({ facts: { current: null as FileFacts | null } }))
vi.mock('@/state/file-facts', () => ({ useFileFacts: () => facts.current }))

test('shows created with its author, and links, and nothing the header says', () => {
  facts.current = {
    history: {
      last: { date: '2026-09-25T10:00:00', author: 'ada-holm' },
      first: { date: '2026-03-02T10:00:00', author: 'bo-lind' },
      revisions: 14,
    },
    links: { in: 3, out: 5 },
  }
  render(<FileFactsRows path="notes/plan.md" />)

  expect(screen.getByText('02/03/26,', { exact: false })).toHaveTextContent('02/03/26, bo-lind')
  expect(screen.getByRole('link', { name: 'bo-lind' })).toHaveAttribute(
    'href',
    'https://github.com/bo-lind',
  )
  expect(screen.getByText('3 in · 5 out')).toBeInTheDocument()
  // Last updated, version and size are on the header above the open block.
  for (const label of ['updated', 'revisions', 'chars']) {
    expect(screen.queryByText(label)).not.toBeInTheDocument()
  }
})

test('a file never committed has no created date', () => {
  facts.current = { history: null, links: { in: 0, out: 0 } }
  render(<FileFactsRows path="notes/new.md" />)
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})

test('the rows are there before the answer is, so the block does not grow', () => {
  facts.current = null
  render(<FileFactsRows path="notes/plan.md" />)
  for (const label of ['created', 'links']) expect(screen.getByText(label)).toBeInTheDocument()
})
