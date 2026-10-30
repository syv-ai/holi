import { expect, test } from 'vitest'
import { render } from '@/test/render'
import { AgentMark, pluginMark } from '../marks'

test('Claude uses a neutral mark except in General Settings', () => {
  const { container, rerender } = render(<AgentMark agent="claude" />)
  expect(container.querySelector('svg')).not.toHaveClass('text-orange-500')

  rerender(<AgentMark agent="claude" brandClaude />)
  expect(container.querySelector('svg')).toHaveClass('text-orange-500')
})

test('generic agent marks do not use the Claude brand', () => {
  const { container } = render(
    <>
      <AgentMark agent={undefined} />
      {pluginMark('agent')}
    </>,
  )
  for (const mark of container.querySelectorAll('svg')) {
    expect(mark).not.toHaveClass('text-orange-500')
  }
})

test('uses the monochrome 4x4 Pi staircase mark', () => {
  const { container } = render(<AgentMark agent="pi" />)
  const mark = container.querySelector('svg')
  expect(mark).not.toBeNull()
  expect(mark).toHaveAttribute('viewBox', '0 0 24 24')
  expect(mark?.querySelector('path')).toHaveAttribute(
    'd',
    'M0 0h6v6H0zm6 0h6v6H6zm6 0h6v6h-6zM0 6h6v6H0zm12 0h6v6h-6zM0 12h6v6H0zm6 0h6v6H6zm12 0h6v6h-6zM0 18h6v6H0zm18 0h6v6h-6z',
  )
  expect(mark).toHaveAttribute('aria-hidden', 'true')
})
