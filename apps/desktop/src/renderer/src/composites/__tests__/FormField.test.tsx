import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Input } from '../../primitives/Input'
import { FormField } from '../FormField'

test('shows the label and the error, error carries the danger token', () => {
  render(
    <FormField label="Title" error="required">
      <Input aria-label="Title" defaultValue="" />
    </FormField>,
  )
  expect(screen.getByText('Title')).toBeInTheDocument()
  expect(screen.getByText('required')).toHaveClass('text-danger')
})

test('no error node when error is absent', () => {
  render(
    <FormField label="Folder">
      <Input aria-label="Folder" />
    </FormField>,
  )
  expect(screen.queryByText('required')).not.toBeInTheDocument()
})
