/**
 * Panel layouts, and the two rules that decide where one is filed and whether it
 * is written at all.
 *
 * Dragging itself is not testable here: `react-resizable-panels` works from
 * measured geometry and jsdom measures nothing. What *is* testable is which
 * store a layout lands in, and the `isUserInteraction` guard.
 */
import { Provider, createStore, useAtomValue } from 'jotai'
import { beforeEach, expect, test } from 'vitest'
import { render } from '@/test/render'
import {
  globalPanelLayoutsAtom,
  vimCodeEditingAtom,
  useGlobalPanelLayout,
  type PanelLayoutBinding,
} from '../preferences'

/** Hands the binding back so a test can call `onLayoutChanged` the way the panel
 *  group would, without a panel group. */
function Probe({ bind }: { bind: (binding: PanelLayoutBinding) => void }): null {
  bind(useGlobalPanelLayout('mail'))
  return null
}

function VimProbe({ bind }: { bind: (value: boolean) => void }): null {
  bind(useAtomValue(vimCodeEditingAtom))
  return null
}

const DRAG = { isUserInteraction: true }
const REFLOW = { isUserInteraction: false }

beforeEach(() => localStorage.clear())

test.each(['"true"', '[]', '{'])(
  'Vim preference validates malformed local storage on mount: %s',
  (raw) => {
    localStorage.setItem('holi:vimCodeEditing', raw)
    const store = createStore()
    let restored = true
    render(
      <Provider store={store}>
        <VimProbe bind={(value) => (restored = value)} />
      </Provider>,
    )
    expect(restored).toBe(false)
  },
)

test('Vim editing is off by default, machine-wide, and rejects malformed stored values', () => {
  expect(createStore().get(vimCodeEditingAtom)).toBe(false)

  localStorage.setItem('holi:vimCodeEditing', JSON.stringify('true'))
  expect(createStore().get(vimCodeEditingAtom)).toBe(false)

  const firstLaunch = createStore()
  render(
    <Provider store={firstLaunch}>
      <Probe bind={() => undefined} />
      <VimProbe bind={() => undefined} />
    </Provider>,
  )
  firstLaunch.set(vimCodeEditingAtom, true)
  expect(localStorage.getItem('holi:vimCodeEditing')).toBe('true')

  const restarted = createStore()
  let restored = false
  render(
    <Provider store={restarted}>
      <VimProbe bind={(value) => (restored = value)} />
    </Provider>,
  )
  expect(restored).toBe(true)
})

test('a drag on an account-wide split is stored without a vault in the key', () => {
  const store = createStore()
  let binding!: PanelLayoutBinding
  render(
    <Provider store={store}>
      <Probe bind={(b) => (binding = b)} />
    </Provider>,
  )

  binding.onLayoutChanged({ list: 30, reader: 70 }, DRAG)

  // Mail and the agenda are account-wide singletons. Filing the split
  // under a remote would remember a different width per vault for identical
  // content, and nothing at all with no vault open.
  expect(store.get(globalPanelLayoutsAtom)).toEqual({ mail: { list: 30, reader: 70 } })
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
  // that overwrites the width the user actually dragged.
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

  // No remote is set anywhere in this test: that is the point.
  expect(binding.defaultLayout).toEqual({ list: 30, reader: 70 })
})
