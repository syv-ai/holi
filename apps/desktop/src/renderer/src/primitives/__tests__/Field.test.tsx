import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { FormField } from '../Field'
import { Input } from '../Input'
import { TooltipProvider } from '../Tooltip'

test('shows the label and the error, error carries the destructive token', () => {
  render(
    <FormField label="Title" error="required">
      <Input defaultValue="" />
    </FormField>,
  )
  expect(screen.getByRole('textbox', { name: /Title/ })).toBeInTheDocument()
  expect(screen.getByText('required')).toHaveClass('text-destructive')
})

test('no error node when error is absent', () => {
  render(
    <FormField label="Folder">
      <Input />
    </FormField>,
  )
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('horizontal: the label points at the control the id is handed to', async () => {
  render(
    <TooltipProvider>
      <FormField orientation="horizontal" label="due">
        {(id) => <Input id={id} />}
      </FormField>
    </TooltipProvider>,
  )
  const input = screen.getByRole('textbox', { name: 'due' })
  await userEvent.click(screen.getByText('due'))
  expect(input).toHaveFocus()
})
