/** The chat box's placeholder goes the way text does: Backspace clears it. */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { RichInput } from '../renderer/chat/RichInput'

function box(onShiftTab?: () => void): HTMLElement {
  render(
    <RichInput
      value=""
      markers={[]}
      onChange={vi.fn()}
      onEnter={vi.fn()}
      {...(onShiftTab === undefined ? {} : { onShiftTab })}
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

test('Shift+Tab goes to the session, and the focus stays in the box', async () => {
  const user = userEvent.setup()
  const onShiftTab = vi.fn()
  const field = box(onShiftTab)
  await user.click(field)
  await user.keyboard('{Shift>}{Tab}{/Shift}')
  expect(onShiftTab).toHaveBeenCalledOnce()
  expect(field).toHaveFocus()
})
