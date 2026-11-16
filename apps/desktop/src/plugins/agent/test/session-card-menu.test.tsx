import { Provider, createStore } from 'jotai'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/render'
import { expect, test } from 'vitest'
import { CardWithMenu } from '../renderer/sessions/session-card-menu'
import type { SessionRow } from '../renderer/state/session-list'

const row = {
  item: {
    key: 'agent:p123456789ab',
    title: 'Test session',
    state: 'idle',
    updatedAt: 0,
    agent: 'claude',
    sessionId: 'conversation-id',
  },
  state: 'idle',
  current: false,
} as SessionRow

function setup() {
  const store = createStore()
  render(
    <Provider store={store}>
      <CardWithMenu
        row={row}
        renaming={false}
        onRename={() => {}}
        onRenamed={() => {}}
        onDelete={() => {}}
        closable={false}
      >
        <button type="button">Session card</button>
      </CardWithMenu>
    </Provider>,
  )
}

test('opening a terminal from the dropdown does not restore focus to its trigger', async () => {
  setup()
  const user = userEvent.setup()
  const trigger = screen.getByRole('button', { name: 'More actions for Test session' })
  await user.click(trigger)
  await user.click(await screen.findByRole('menuitem', { name: 'Open in terminal' }))

  await waitFor(() => expect(trigger).not.toHaveFocus())
})

test('dismissing the dropdown with Escape restores focus to its trigger', async () => {
  setup()
  const user = userEvent.setup()
  const trigger = screen.getByRole('button', { name: 'More actions for Test session' })
  await user.click(trigger)
  await user.keyboard('{Escape}')

  await waitFor(() => expect(trigger).toHaveFocus())
})
