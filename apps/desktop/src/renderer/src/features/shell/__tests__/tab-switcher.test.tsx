import { EditorView } from '@codemirror/view'
import { Provider, createStore } from 'jotai'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import { useShortcutDispatcher } from '@/hooks/use-shortcuts'
import { TabSwitcher, TabSwitcherButton } from '../tab-switcher'
import { expect, test, vi } from 'vitest'

function Host({ onSelect }: { onSelect: (id: string) => void }) {
  useShortcutDispatcher()
  return (
    <TabSwitcher
      order={['second', 'first']}
      active="first"
      onSelect={onSelect}
      row={(id) => ({ name: id, content: id })}
    >
      <div>
        <div id="editor" />
        <TabSwitcherButton>2 tabs</TabSwitcherButton>
      </div>
    </TabSwitcher>
  )
}

test('switching from CodeMirror releases to select and Escape never reaches the editor', async () => {
  const store = createStore()
  const onSelect = vi.fn()
  const mounted = render(
    <Provider store={store}>
      <Host onSelect={onSelect} />
    </Provider>,
  )
  const editor = new EditorView({ parent: mounted.container.querySelector('#editor')! })
  const escape = vi.fn()
  editor.dom.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') escape()
  })
  editor.focus()
  expect(document.activeElement).toBe(editor.contentDOM)
  fireEvent.keyDown(editor.contentDOM, { key: 'Escape' })
  expect(escape).toHaveBeenCalledOnce()
  escape.mockClear()

  act(() => {
    fireEvent.keyDown(editor.contentDOM, { key: 'Tab', ctrlKey: true })
  })
  expect(screen.getByRole('group', { name: 'Switch tab' })).toBeTruthy()
  expect(document.activeElement).toBe(editor.contentDOM)
  act(() => {
    fireEvent.keyUp(window, { key: 'Control', ctrlKey: false })
  })
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith('second'))
  expect(screen.queryByRole('group', { name: 'Switch tab' })).toBeNull()
  expect(document.activeElement).toBe(editor.contentDOM)

  onSelect.mockClear()
  act(() => {
    fireEvent.keyDown(editor.contentDOM, { key: 'Tab', ctrlKey: true })
  })
  expect(screen.getByRole('group', { name: 'Switch tab' })).toBeTruthy()
  expect(document.activeElement).toBe(editor.contentDOM)
  act(() => {
    fireEvent.keyDown(editor.contentDOM, { key: 'Escape', ctrlKey: true })
  })
  expect(escape).not.toHaveBeenCalled()
  expect(onSelect).not.toHaveBeenCalled()
  expect(screen.queryByRole('group', { name: 'Switch tab' })).toBeNull()
  expect(document.activeElement).toBe(editor.contentDOM)
  editor.destroy()
})

test('the tab count opens the list pinned: Control let go keeps it, the count closes it, Enter opens', async () => {
  const onSelect = vi.fn()
  render(
    <Provider store={createStore()}>
      <Host onSelect={onSelect} />
    </Provider>,
  )
  const count = screen.getByRole('button', { name: '2 tabs' })
  fireEvent.pointerDown(count)
  fireEvent.click(count)
  expect(screen.getByRole('group', { name: 'Switch tab' })).toBeTruthy()
  fireEvent.keyUp(window, { key: 'Control', ctrlKey: false })
  expect(screen.getByRole('group', { name: 'Switch tab' })).toBeTruthy()
  fireEvent.pointerDown(count)
  fireEvent.click(count)
  await waitFor(() => expect(screen.queryByRole('group', { name: 'Switch tab' })).toBeNull())
  expect(onSelect).not.toHaveBeenCalled()

  fireEvent.click(count)
  fireEvent.keyDown(window, { key: 'Enter' })
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith('second'))
})
