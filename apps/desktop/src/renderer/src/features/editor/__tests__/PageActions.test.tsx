/**
 * The page controls after ReUI's page header and page actions: saved state,
 * Undo/Redo, the page toggles, Export and Clear page.
 */
import { history } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import userEvent from '@testing-library/user-event'
import { createStore } from 'jotai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/render'
import { updateBus } from '@/editor/update-bus'
import { NOTE_PAGE_DEFAULTS, notePageAtom, notePagesAtom } from '@/state/note-page'
import { PageActions } from '../PageActions'

const user = userEvent.setup({ pointerEventsCheck: 0 })

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
})

function mount(doc: string) {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [history(), markdown(), updateBus] }),
    parent: document.body.appendChild(document.createElement('div')),
  })
  return view
}

function setup(doc = '---\ntitle: x\n---\n# Plan\n\nbody\n') {
  const v = mount(doc)
  const onPageChange = vi.fn()
  const onNotice = vi.fn()
  render(
    <PageActions
      view={v}
      title="Plan"
      page={NOTE_PAGE_DEFAULTS}
      onPageChange={onPageChange}
      saving={false}
      showOutline={false}
      onNotice={onNotice}
    />,
  )
  return { v, onPageChange, onNotice }
}

describe('the page controls', () => {
  it('say the page is saved, and Undo waits for something to undo', () => {
    setup()
    expect(screen.getByText('Saved')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Undo' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('offer the page toggles ReUI has', async () => {
    const { onPageChange } = setup()
    await user.click(screen.getByRole('button', { name: 'Page actions' }))
    for (const name of ['Full width', 'Small text', 'Lock page']) {
      expect(screen.getByRole('menuitemcheckbox', { name })).toBeTruthy()
    }
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Full width' }))
    expect(onPageChange).toHaveBeenCalledWith({ fullWidth: true })
  })

  it('export as HTML, text and markdown', async () => {
    setup()
    await user.click(screen.getByRole('button', { name: 'Page actions' }))
    for (const name of ['Copy as HTML', 'Copy as text', 'Copy as markdown']) {
      expect(screen.getByRole('menuitem', { name })).toBeTruthy()
    }
  })

  it('clear the page after a confirm, keep the properties, and offer Undo', async () => {
    const { v, onNotice } = setup()
    await user.click(screen.getByRole('button', { name: 'Page actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Clear page' }))
    expect(screen.getByText('Clear page?')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Clear page' }))
    expect(v.state.doc.toString()).toBe('---\ntitle: x\n---\n')
    expect(onNotice).toHaveBeenCalledWith('Page cleared', expect.any(Function))
    onNotice.mock.calls[0]![1]()
    expect(v.state.doc.toString()).toBe('---\ntitle: x\n---\n# Plan\n\nbody\n')
  })
})

describe('the page toggles are machine-local, per note', () => {
  it('store only what differs from the defaults', () => {
    const store = createStore()
    const page = notePageAtom('o/r', 'a.md')
    store.set(page, { fullWidth: true })
    expect(store.get(page)).toEqual({ ...NOTE_PAGE_DEFAULTS, fullWidth: true })
    expect(store.get(notePageAtom('o/r', 'b.md'))).toEqual(NOTE_PAGE_DEFAULTS)
    store.set(page, { fullWidth: false })
    expect(store.get(notePagesAtom)).toEqual({})
  })
})
