import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { Button } from '../Button'
import { Tooltip } from '../Tooltip'

test('reveals its content when the trigger is focused', async () => {
  render(
    <Tooltip content="Restart session">
      <Button aria-label="restart">↻</Button>
    </Tooltip>,
  )
  expect(screen.queryByText('Restart session')).not.toBeInTheDocument()
  await userEvent.tab() // focus the trigger
  // Radix renders the content into a role=tooltip node (and a visually-hidden copy).
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Restart session')
})

test('passes the trigger through untouched when there is no content', () => {
  render(
    <Tooltip content="">
      <Button aria-label="restart">↻</Button>
    </Tooltip>,
  )
  expect(screen.getByRole('button', { name: 'restart' })).toBeInTheDocument()
})
