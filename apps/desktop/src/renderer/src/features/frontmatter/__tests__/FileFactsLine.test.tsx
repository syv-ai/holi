import { render, screen } from '@/test/render'
import { expect, test, vi } from 'vitest'
import type { FileFacts } from '@/state/file-facts'
import { FileFactsLine } from '../FileFactsLine'

const { facts } = vi.hoisted(() => ({ facts: { current: null as FileFacts | null } }))
vi.mock('@/state/file-facts', () => ({ useFileFacts: () => facts.current }))

const line = () => document.querySelector('[data-fm-facts]')!

const PLAN: FileFacts = {
  history: {
    last: { date: '2026-09-25T10:00:00', author: 'ada-holm' },
    first: { date: '2026-03-02T10:00:00', author: 'bo-lind' },
    revisions: 14,
  },
  links: { in: 3, out: 5 },
}

test('one line: the folder, when it was created and by whom, and the links', () => {
  facts.current = PLAN
  render(<FileFactsLine path="work/projects/plan.md" />)

  expect(line()).toHaveTextContent('In work/projects · created 02/03/26, bo-lind · 8 links')
  expect(screen.getByRole('link', { name: 'bo-lind' })).toHaveAttribute(
    'href',
    'https://github.com/bo-lind',
  )
  // Last updated, version and size are on the header above the open block.
  expect(line()).not.toHaveTextContent(/updated|v\.14|chars/)
})

test('a file at the vault root has no folder part at all', () => {
  // `lastIndexOf('/')` is -1 there, and `slice(0, -1)` is the path minus its
  // last character: the line would show the file's own name, one letter short.
  facts.current = PLAN
  render(<FileFactsLine path="task.a.md" />)
  expect(line().textContent).toMatch(/^created/)
})

test('a file never committed has no created part', () => {
  facts.current = { history: null, links: { in: 0, out: 1 } }
  render(<FileFactsLine path="notes/new.md" />)
  expect(line()).toHaveTextContent('In notes · 1 link')
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})

test('the line holds its place but stays invisible until the answer', () => {
  facts.current = null
  render(<FileFactsLine path="notes/plan.md" />)
  expect(line().className).toContain('invisible')
})
