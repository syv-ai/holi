import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Button } from '../Button'

test('renders a button with its label', () => {
  render(<Button>Save</Button>)
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
})

test('destructive variant carries the destructive token class', () => {
  render(<Button variant="destructive">Delete</Button>)
  expect(screen.getByRole('button')).toHaveClass('bg-destructive')
})

test('caller className overrides the default (tailwind-merge wins)', () => {
  render(<Button className="bg-secondary">x</Button>)
  const el = screen.getByRole('button')
  expect(el).toHaveClass('bg-secondary')
  expect(el).not.toHaveClass('bg-primary')
})

test('disabled prop reaches the element', () => {
  render(<Button disabled>x</Button>)
  expect(screen.getByRole('button')).toBeDisabled()
})
