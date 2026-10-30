import { expect, test } from 'vitest'
import { render } from '@/test/render'
import { AgentMark } from '../marks'

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
