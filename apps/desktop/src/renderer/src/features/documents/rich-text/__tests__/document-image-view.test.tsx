import { Editor, EditorContent } from '@tiptap/react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDocumentExtensions } from '@/features/documents/document-extensions'

let editor: Editor | null = null
let view: ReturnType<typeof render> | null = null

afterEach(() => {
  view?.unmount()
  view = null
  act(() => editor?.destroy())
  editor = null
})

function mount(content: string) {
  editor = new Editor({
    extensions: createDocumentExtensions({
      folder: 'notes',
      placeholder: '',
      onOpenLink: () => undefined,
    }),
    content,
    contentType: 'markdown',
  })
  view = render(createElement(EditorContent, { editor }))
  return editor
}

describe('document image node view', () => {
  it('opens the image dialog by mouse and keyboard, then returns focus on close', async () => {
    mount('![Portrait](../assets/photo.png)')
    const trigger = screen.getByRole('button', { name: 'Open Portrait' })
    fireEvent.click(trigger)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))

    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(trigger)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('preserves markdown and document state during read-only inspection', async () => {
    const e = mount('![Portrait](../assets/photo.png)')
    const markdown = e.getMarkdown()
    const doc = e.state.doc
    const update = vi.fn()
    e.on('update', update)
    fireEvent.click(screen.getByRole('button', { name: 'Open Portrait' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Portrait' })).toBeTruthy()
    expect(e.state.doc).toBe(doc)
    expect(e.getMarkdown()).toBe(markdown)
    expect(update).not.toHaveBeenCalled()
    expect(e.can().undo()).toBe(false)
  })

  it('shows retry after preview load failure without removing the dialog', async () => {
    mount('![Portrait](photo.png)')
    fireEvent.click(screen.getByRole('button', { name: 'Open Portrait' }))
    const dialog = await screen.findByRole('dialog')
    const preview = dialog.querySelector('img')
    expect(preview).not.toBeNull()
    fireEvent.error(preview!)
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBe(dialog)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByRole('dialog')).toBe(dialog)
  })
})
