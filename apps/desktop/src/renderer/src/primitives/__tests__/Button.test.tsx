import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Button } from '../Button'

test('renders a button with its label', () => {
  render(<Button>Save</Button>)
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
})

test('danger variant carries the danger token class', () => {
  render(<Button variant="danger">Delete</Button>)
  expect(screen.getByRole('button')).toHaveClass('bg-danger')
})

test('caller className overrides the default (tailwind-merge wins)', () => {
  render(<Button className="bg-surface">x</Button>)
  const el = screen.getByRole('button')
  expect(el).toHaveClass('bg-surface')
  expect(el).not.toHaveClass('bg-accent')
})

test('disabled prop reaches the element', () => {
  render(<Button disabled>x</Button>)
  expect(screen.getByRole('button')).toBeDisabled()
})
