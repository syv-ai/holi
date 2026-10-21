/**
 * Folder colours: per vault and on this machine, set and cleared by path, and
 * nothing but a known colour ever reaches the tree.
 */
import { createStore } from 'jotai'
import { beforeEach, expect, test } from 'vitest'
import { folderColoursAtom, folderColoursByVaultAtom, setFolderColourAtom } from '../folder-colours'
import { activeRemoteAtom } from '../vaults'

beforeEach(() => localStorage.clear())

test('colours a folder in the open vault only, and clears it', () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/notes')
  store.set(setFolderColourAtom, { path: 'Projects', colour: 'violet' })
  expect(store.get(folderColoursAtom)).toEqual({ Projects: 'violet' })

  store.set(activeRemoteAtom, 'syv-ai/other')
  expect(store.get(folderColoursAtom)).toEqual({})

  store.set(activeRemoteAtom, 'syv-ai/notes')
  store.set(setFolderColourAtom, { path: 'Projects', colour: null })
  expect(store.get(folderColoursAtom)).toEqual({})
})

test('reads an unknown stored colour as none', () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/notes')
  store.set(folderColoursByVaultAtom, {
    'syv-ai/notes': { A: 'teal', B: 'chartreuse' as never },
  })
  expect(store.get(folderColoursAtom)).toEqual({ A: 'teal' })
})

test('does nothing without an open vault', () => {
  const store = createStore()
  store.set(setFolderColourAtom, { path: 'Projects', colour: 'red' })
  expect(store.get(folderColoursByVaultAtom)).toEqual({})
})
