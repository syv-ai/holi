import { EditorView } from '@codemirror/view'
import { Provider, createStore } from 'jotai'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import { useShortcutDispatcher } from '@/hooks/use-shortcuts'
import { TabSwitcher } from '../tab-switcher'
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
      <div id="editor" />
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
