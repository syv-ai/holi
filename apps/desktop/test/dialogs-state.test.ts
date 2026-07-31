import { createStore } from 'jotai'
import { expect, test } from 'vitest'
import { activeDialogAtom, closeDialogAtom, openDialogAtom } from '@/state/dialogs'

test('open sets the active dialog; close clears it', () => {
  const store = createStore()
  expect(store.get(activeDialogAtom)).toBeNull()

  store.set(openDialogAtom, { id: 'create-task', size: 'md', mode: 'quick' })
  expect(store.get(activeDialogAtom)).toMatchObject({ id: 'create-task', size: 'md' })

  store.set(closeDialogAtom)
  expect(store.get(activeDialogAtom)).toBeNull()
})
