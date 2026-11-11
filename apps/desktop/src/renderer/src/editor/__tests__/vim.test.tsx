import { act, renderHook } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, it, vi } from 'vitest'
import { useVimEditor } from '../vim'

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
})

function makeView() {
  const parent = document.createElement('div')
  document.body.append(parent)
  view = new EditorView({ state: EditorState.create({ doc: 'start' }), parent })
  return view
}

it('keeps its extension and editor state while applying current enablement and handlers', () => {
  const editorView = makeView()
  const firstMode = vi.fn()
  const firstKey = vi.fn()
  const hook = renderHook(
    ({ enabled, onModeChange, onKeyDown }) =>
      useVimEditor(editorView, enabled, onModeChange, onKeyDown),
    { initialProps: { enabled: false, onModeChange: firstMode, onKeyDown: firstKey } },
  )
  const extension = hook.result.current.extension
  editorView.dispatch({ changes: { from: 0, to: 5, insert: 'edited' }, selection: { anchor: 2 } })

  const latestMode = vi.fn()
  const latestKey = vi.fn()
  act(() => hook.rerender({ enabled: true, onModeChange: latestMode, onKeyDown: latestKey }))
  expect(hook.result.current.extension).toBe(extension)
  expect(editorView.state.doc.toString()).toBe('edited')
  expect(editorView.state.selection.main.anchor).toBe(2)
  expect(hook.result.current.onKeyDownCapture).toBeTypeOf('function')
  expect(hook.result.current.onKeyDown).toBeUndefined()
  act(() => hook.result.current.onKeyDownCapture!({ defaultPrevented: false } as never))
  expect(latestKey).toHaveBeenCalledOnce()

  act(() => hook.rerender({ enabled: false, onModeChange: latestMode, onKeyDown: latestKey }))
  expect(hook.result.current.onKeyDown).toBeTypeOf('function')
  expect(hook.result.current.onKeyDownCapture).toBeUndefined()
  const event = { defaultPrevented: true }
  act(() => hook.result.current.onKeyDown!(event as never))
  expect(latestKey).toHaveBeenCalledOnce()
  expect(latestMode).toHaveBeenCalledWith('')
  hook.unmount()
})

it('starts a replacement view with current enablement and suppresses mode reports after teardown', async () => {
  const callback = vi.fn()
  const handler = vi.fn()
  const hook = renderHook(
    ({ currentView, enabled }) => useVimEditor(currentView, enabled, callback, handler),
    { initialProps: { currentView: null as EditorView | null, enabled: false } },
  )
  act(() => hook.rerender({ currentView: makeView(), enabled: true }))
  const nextView = view!
  expect(nextView.state.facet(EditorState.allowMultipleSelections)).toBe(false)
  expect(callback).toHaveBeenCalledWith('normal')
  const reportsBeforeUnmount = callback.mock.calls.length
  hook.unmount()
  await Promise.resolve()
  expect(callback).toHaveBeenCalledTimes(reportsBeforeUnmount)
})
