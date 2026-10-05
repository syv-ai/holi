/** The chat box's placeholder goes the way text does: Backspace clears it. */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { RichInput } from '../renderer/chat/RichInput'

function box(): HTMLElement {
  render(
    <RichInput
      value=""
      markers={[]}
      onChange={vi.fn()}
      onEnter={vi.fn()}
      handle={null}
      placeholder="Message Ada"
      label="Message"
    />,
  )
  return screen.getByRole('textbox', { name: 'Message' })
}

test('backspace on the empty box clears the placeholder, and typing keeps it gone', async () => {
  const user = userEvent.setup()
  const field = box()
  expect(field).toHaveAttribute('data-empty')
  await user.click(field)
  await user.keyboard('{Backspace}')
  expect(field).not.toHaveAttribute('data-empty')
})

test('leaving the box brings the placeholder back', async () => {
  const user = userEvent.setup()
  const field = box()
  await user.click(field)
  await user.keyboard('{Backspace}')
  await user.tab()
  expect(field).toHaveAttribute('data-empty')
})
