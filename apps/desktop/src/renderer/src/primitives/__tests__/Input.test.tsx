import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Input } from '../Input'

test('renders and forwards native props', () => {
  render(<Input placeholder="search" defaultValue="x" />)
  const el = screen.getByPlaceholderText('search')
  expect(el).toBeInTheDocument()
  expect(el).toHaveValue('x')
})

test('caller className overrides the default (tailwind-merge wins)', () => {
  render(<Input aria-label="f" className="bg-background" />)
  const el = screen.getByLabelText('f')
  expect(el).toHaveClass('bg-background')
  expect(el).not.toHaveClass('bg-transparent')
})
