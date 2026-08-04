/**
 * Panel layouts, and the two rules that decide where one is filed and whether it
 * is written at all.
 *
 * Dragging itself is not testable here — `react-resizable-panels` works from
 * measured geometry and jsdom measures nothing. What *is* testable is everything
 * around the drag: which store a layout lands in, and the `isUserInteraction`
 * guard, which is the rule that has already gone wrong once (Shell.tsx:230).
 */
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test } from 'vitest'
import { render } from '@/test/render'
import {
  globalPanelLayoutsAtom,
  panelLayoutsByVaultAtom,
  useGlobalPanelLayout,
  usePanelLayout,
  type PanelLayoutBinding,
} from '../preferences'

/** Hands the binding back so a test can call `onLayoutChanged` the way the panel
 *  group would, without a panel group. */
function Probe({ bind }: { bind: (binding: PanelLayoutBinding) => void }): null {
  bind(useGlobalPanelLayout('mail'))
  return null
}

function VaultProbe({
  remote,
  bind,
}: {
  remote: string | null
  bind: (binding: PanelLayoutBinding) => void
}): null {
  bind(usePanelLayout(remote, 'shell'))
  return null
}

const DRAG = { isUserInteraction: true }
const REFLOW = { isUserInteraction: false }

beforeEach(() => localStorage.clear())

test('a drag on an account-wide split is stored without a vault in the key', () => {
  const store = createStore()
  let binding!: PanelLayoutBinding
  render(
    <Provider store={store}>
      <Probe bind={(b) => (binding = b)} />
    </Provider>,
  )

  binding.onLayoutChanged({ list: 30, reader: 70 }, DRAG)

  // Mail and the agenda are account-wide singletons (D67) — the same two panes
  // whichever vault is open, and open at all with no vault. Filing the split
  // under a remote would remember a different width per vault for identical
  // content, and remember nothing at all before the first vault is added.
  expect(store.get(globalPanelLayoutsAtom)).toEqual({ mail: { list: 30, reader: 70 } })
  expect(store.get(panelLayoutsByVaultAtom)).toEqual({})
})

test('an account-wide split ignores a programmatic reflow', () => {
  const store = createStore()
  let binding!: PanelLayoutBinding
  render(
    <Provider store={store}>
      <Probe bind={(b) => (binding = b)} />
    </Provider>,
  )

  binding.onLayoutChanged({ list: 30, reader: 70 }, DRAG)
  binding.onLayoutChanged({ list: 50, reader: 50 }, REFLOW)

  // Mounting a group, or opening any sibling panel in it, makes the library
  // recompute every size and report it with `isUserInteraction: false`. Saving
  // that overwrites the width the user actually dragged — the bug already
  // commented at Shell.tsx:230, now guarded on this path too.
  expect(store.get(globalPanelLayoutsAtom).mail).toEqual({ list: 30, reader: 70 })
})

test('the account-wide layout is restored whether or not a vault is open', () => {
  const store = createStore()
  store.set(globalPanelLayoutsAtom, { mail: { list: 30, reader: 70 } })
  let binding!: PanelLayoutBinding
  render(
    <Provider store={store}>
      <Probe bind={(b) => (binding = b)} />
    </Provider>,
  )

  // No remote is set anywhere in this test — that is the point.
  expect(binding.defaultLayout).toEqual({ list: 30, reader: 70 })
})

test('a vault-scoped split still refuses to save without a vault', () => {
  const store = createStore()
  let binding!: PanelLayoutBinding
  render(
    <Provider store={store}>
      <VaultProbe remote={null} bind={(b) => (binding = b)} />
    </Provider>,
  )

  binding.onLayoutChanged({ nav: 20, editor: 80 }, DRAG)

  // Unchanged behaviour, asserted because the account-wide sibling now sits
  // beside it: the workspace row genuinely is per-vault, and has no key to
  // write under until a vault is open.
  expect(store.get(panelLayoutsByVaultAtom)).toEqual({})
})
