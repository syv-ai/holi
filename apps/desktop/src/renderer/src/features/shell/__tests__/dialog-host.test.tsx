import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { createStore, Provider } from 'jotai'
import { describe, expect, test } from 'vitest'
import { Button } from '@/components/ui/button'
import { DialogTitle } from '@/components/ui/dialog'
import { openDialogAtom } from '@/state/dialogs'
import { DialogHost } from '../dialog-host'

function mount() {
  const store = createStore()
  render(
    <Provider store={store}>
      <DialogHost />
    </Provider>,
  )
  return store
}

describe('DialogHost', () => {
  test("draws a plugin's dialog, and its close closes it", async () => {
    const store = mount()
    store.set(openDialogAtom, {
      id: 'plugin',
      size: 'md',
      render: (close) => (
        <>
          <DialogTitle>Run Prezzi?</DialogTitle>
          <Button onClick={close}>Not now</Button>
        </>
      ),
    })
    expect(await screen.findByRole('dialog', { name: 'Run Prezzi?' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('Escape closes it too', async () => {
    const store = mount()
    store.set(openDialogAtom, {
      id: 'plugin',
      size: 'sm',
      render: () => <DialogTitle>Compose</DialogTitle>,
    })
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('a core dialog with no component in this shell shows nothing', () => {
    const store = mount()
    store.set(openDialogAtom, { id: 'create-task', size: 'md' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
