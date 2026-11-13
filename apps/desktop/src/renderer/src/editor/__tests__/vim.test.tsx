import { act, renderHook } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, it, vi } from 'vitest'
import { getCM, Vim } from '@replit/codemirror-vim'
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
      useVimEditor(editorView, enabled, true, onModeChange, onKeyDown),
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

it('retains real Vim insert mode when the editor becomes inactive', async () => {
  const callback = vi.fn()
  const handler = vi.fn()
  const hook = renderHook(
    ({ currentView, active }) => useVimEditor(currentView, true, active, callback, handler),
    { initialProps: { currentView: null as EditorView | null, active: true } },
  )
  const parent = document.createElement('div')
  document.body.append(parent)
  const editorView = new EditorView({
    state: EditorState.create({ doc: 'start', extensions: [hook.result.current.extension] }),
    parent,
  })
  view = editorView
  act(() => hook.rerender({ currentView: editorView, active: true }))

  await act(async () => {
    editorView.focus()
    Vim.handleKey(getCM(editorView)!, 'i', 'keydown')
    await Promise.resolve()
  })
  expect(getCM(editorView)?.state.vim?.insertMode).toBe(true)
  act(() => hook.rerender({ currentView: editorView, active: false }))
  expect(getCM(editorView)?.state.vim?.insertMode).toBe(true)
  expect(hook.result.current.onKeyDownCapture).toBeUndefined()
  expect(hook.result.current.onKeyDown).toBeUndefined()
  hook.unmount()
})

it('starts a replacement view with current enablement and suppresses mode reports after teardown', async () => {
  const callback = vi.fn()
  const handler = vi.fn()
  const hook = renderHook(
    ({ currentView, enabled }) => useVimEditor(currentView, enabled, enabled, callback, handler),
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
