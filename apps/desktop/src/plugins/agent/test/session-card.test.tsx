import { render, screen } from '@/test/render'
import { expect, test } from 'vitest'
import { SessionCard } from '../renderer/sessions/session-card'
import type { SessionRow } from '../renderer/state/session-list'

const NOW = Date.parse('2026-11-05T12:00:00Z')

const row = {
  item: {
    key: 'session:test',
    title: 'Test session',
    state: 'idle',
    updatedAt: NOW - 60_000,
    agent: 'claude',
    model: 'opus',
    location: 'project',
  },
  state: 'idle',
  current: false,
} as SessionRow

test('unselected age and provider metadata use foreground ink on button hover', () => {
  render(<SessionCard row={row} now={NOW} focusable onOpen={() => {}} onFocus={() => {}} />)

  const button = screen.getByRole('button', { name: /Test session/ })
  expect(button).toHaveClass('group')

  const age = button.querySelector('.tabular-nums')
  expect(age).toHaveClass('text-muted-foreground', 'group-hover:text-foreground')

  const metadata = button.querySelector('.text-xs:not(.tabular-nums)')
  expect(metadata).toHaveTextContent('Opus')
  expect(metadata).toHaveClass('text-muted-foreground', 'group-hover:text-foreground')
})
