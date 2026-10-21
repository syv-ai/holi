/**
 * A hideable claim's toggle covers every file the claim took, a local one
 * too: a private task (`task.<name>.local.md`) hides with the other task
 * files, while a local file nothing claims stays in the tree.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { act, renderHook } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { ListTodo } from 'lucide-react'
import type { ReactNode } from 'react'
import { expect, test } from 'vitest'
import type { RendererPlugin } from '@/plugin-api/types'
import { installedPluginsAtom } from '@/state/plugins'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
import { useTreeProjection } from '../useTreeProjection'

const CARDS: RendererPlugin = {
  info: { id: 'cards', label: 'Cards', default: true },
  claims: [
    {
      match: (path) => /(^|\/)card\.[^/]+\.md$/.test(path),
      hideable: { id: 'cards', label: 'card files', icon: ListTodo },
    },
  ],
}

test('the toggle hides and shows a claimed local file with the rest', () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/holi')
  store.set(installedPluginsAtom, [CARDS])
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    files: [{ path: 'USER.local.md', updatedAt: '' }],
    claimed: {
      cards: {
        items: [{ path: 'card.shared.md' }, { path: 'card.mine.local.md' }],
        broken: [],
      },
    },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  const { result } = renderHook(() => useTreeProjection(), { wrapper })

  expect(result.current.visible.paths).toEqual(['USER.local.md'])
  act(() => result.current.toggleClaimed('cards'))
  expect([...result.current.visible.paths].sort()).toEqual([
    'USER.local.md',
    'card.mine.local.md',
    'card.shared.md',
  ])
})
