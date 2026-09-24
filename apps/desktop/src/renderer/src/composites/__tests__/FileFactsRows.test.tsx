import { render, screen } from '@/test/render'
import { expect, test, vi } from 'vitest'
import type { FileFacts } from '@/state/file-facts'
import { FileFactsRows } from '../FileFactsRows'

const { facts } = vi.hoisted(() => ({ facts: { current: null as FileFacts | null } }))
vi.mock('@/state/file-facts', () => ({ useFileFacts: () => facts.current }))

test('shows last updated and created with their authors, revisions, size and links', () => {
  facts.current = {
    history: {
      last: { date: '2026-09-25T10:00:00', author: 'ada-holm' },
      first: { date: '2026-03-02T10:00:00', author: 'bo-lind' },
      revisions: 14,
    },
    links: { in: 3, out: 5 },
  }
  render(<FileFactsRows path="notes/plan.md" chars={1840} />)

  expect(screen.getByText('25/09/26,', { exact: false })).toHaveTextContent('25/09/26, ada-holm')
  expect(screen.getByRole('link', { name: 'bo-lind' })).toHaveAttribute(
    'href',
    'https://github.com/bo-lind',
  )
  expect(screen.getByText('14')).toBeInTheDocument()
  expect(screen.getByText('1.8K')).toBeInTheDocument()
  expect(screen.getByText('3 in · 5 out')).toBeInTheDocument()
})

test('a file never committed says so, and has no created date', () => {
  facts.current = { history: null, links: { in: 0, out: 0 } }
  render(<FileFactsRows path="notes/new.md" chars={0} />)

  expect(screen.getByText('not committed')).toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})

test('the rows are there before the answer is, so the block does not grow', () => {
  facts.current = null
  render(<FileFactsRows path="notes/plan.md" chars={12} />)

  for (const label of ['updated', 'created', 'revisions', 'chars', 'links']) {
    expect(screen.getByText(label)).toBeInTheDocument()
  }
  expect(screen.queryByText('not committed')).not.toBeInTheDocument()
})
