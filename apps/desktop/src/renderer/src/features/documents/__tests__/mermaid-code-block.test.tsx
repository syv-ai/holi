import { Editor, EditorContent } from '@tiptap/react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renderMermaid = vi.hoisted(() => vi.fn())
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: renderMermaid,
  },
}))

import { createDocumentExtensions } from '../document-extensions'

let editor: Editor | null = null

afterEach(() => {
  act(() => editor?.destroy())
  editor = null
})

function makeEditor(markdown: string, editable = true) {
  editor = new Editor({
    extensions: createDocumentExtensions({
      folder: 'notes',
      placeholder: '',
      onOpenLink: () => undefined,
    }),
    content: markdown,
    contentType: 'markdown',
    editable,
  })
  render(createElement(EditorContent, { editor }))
  return editor
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('Mermaid fences in a document editor', () => {
  beforeEach(() => {
    renderMermaid.mockReset()
    renderMermaid.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>',
    })
  })

  it('opens a pending preview with an announced loading state', async () => {
    renderMermaid.mockImplementationOnce(() => new Promise(() => undefined))
    makeEditor('```mermaid\nflowchart LR\n```')
    fireEvent.click(await screen.findByRole('button', { name: 'Open Mermaid diagram' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('[role="status"]')?.textContent).toContain('Rendering diagram…')
  })

  it('renders valid fences at rest and returns to source while the caret is inside', async () => {
    const e = makeEditor('```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter')
    await settle()
    expect(e.view.dom.querySelector('[data-mermaid-diagram] svg')).not.toBeNull()
    expect(e.getMarkdown().trim()).toBe('```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter')

    act(() => {
      e.commands.setTextSelection(3)
      e.view.focus()
    })
    await settle()
    expect(e.view.dom.querySelector('[data-mermaid-diagram]')).toBeNull()
    expect(e.view.dom.querySelector('[data-mermaid-source]')?.textContent).toContain('A --> B')
    act(() => e.view.dom.blur())
    await settle()
    expect(e.view.dom.querySelector('[data-mermaid-diagram]')).not.toBeNull()
  })

  it('keeps empty and rejected diagrams editable and explains render failures', async () => {
    const e = makeEditor('```mermaid\n\n```\n\n```mermaid\nnot valid\n```')
    renderMermaid.mockRejectedValue(new Error('invalid diagram'))
    await settle()
    expect(e.view.dom.querySelectorAll('[data-mermaid-source]')).toHaveLength(2)
    expect(e.view.dom.querySelector('[data-mermaid-diagram]')).toBeNull()
    expect(e.view.dom.querySelector('[role="status"]')?.textContent).toContain(
      "Couldn't draw this diagram",
    )
    expect(e.getMarkdown()).toContain('not valid')
    expect(e.getMarkdown()).not.toContain("Couldn't draw this diagram")
  })

  it('retries a failed Mermaid render from the error action', async () => {
    renderMermaid.mockRejectedValueOnce(new Error('temporary failure'))
    const e = makeEditor('```mermaid\nflowchart LR\n```')
    await screen.findByRole('button', { name: 'Retry' })
    renderMermaid.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>retried</text></svg>',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(e.view.dom.querySelector('[data-mermaid-diagram] svg')).not.toBeNull(),
    )
    expect(renderMermaid).toHaveBeenCalledTimes(2)
  })

  it('recovers after a failed render when the source is corrected', async () => {
    renderMermaid.mockRejectedValueOnce(new Error('invalid diagram'))
    const e = makeEditor('```mermaid\nnot valid\n```')
    await waitFor(() => expect(e.view.dom.textContent).toContain("Couldn't draw this diagram"))
    act(() => e.commands.setContent('```mermaid\nflowchart LR\n```', { contentType: 'markdown' }))
    await waitFor(() =>
      expect(e.view.dom.querySelector('[data-mermaid-diagram] svg')).not.toBeNull(),
    )
    expect(e.view.dom.textContent).not.toContain("Couldn't draw this diagram")
  })

  it('sanitizes renderer SVG before attaching it and stays rendered when read-only', async () => {
    renderMermaid.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)"><text>diagram</text></a></svg>',
    })
    const e = makeEditor('```mermaid\nflowchart LR\n```\n\nAfter', false)
    await settle()
    const svg = e.view.dom.querySelector('[data-mermaid-diagram] svg')
    expect(svg).not.toBeNull()
    expect(svg?.hasAttribute('onload')).toBe(false)
    expect(svg?.querySelector('script')).toBeNull()
    expect(svg?.querySelector('a')).toBeNull()
    act(() => e.commands.setTextSelection(3))
    expect(e.view.dom.querySelector('[data-mermaid-diagram]')).not.toBeNull()
  })

  it('uses SVG-safe labels and suppresses Mermaid error SVG insertion', async () => {
    makeEditor('```mermaid\nflowchart LR\n  A --> B\n```')
    await settle()
    expect(renderMermaid).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('A --> B'),
    )
  })

  it('edits source only through the explicit action after preceding edits', async () => {
    const e = makeEditor('```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter')
    await settle()
    const diagram = e.view.dom.querySelector('[data-mermaid-diagram]')
    expect(diagram).not.toBeNull()
    act(() => {
      e.commands.insertContentAt(0, {
        type: 'paragraph',
        content: [{ type: 'text', text: 'x'.repeat(100) }],
      })
    })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Edit source' }))
    await waitFor(() => {
      expect(e.state.doc.resolve(e.state.selection.from).parent.type.name).toBe('codeBlock')
      expect(e.view.dom.querySelector('[data-mermaid-source]')?.textContent).toContain('A --> B')
    })
    expect(e.state.selection.from).toBeGreaterThan(100)
    expect(e.view.hasFocus()).toBe(true)
    expect(e.state.doc.textBetween(e.state.selection.from, e.state.selection.to)).toBe('')
  })

  it('leaves other code fences unchanged', async () => {
    const e = makeEditor('```js\nconst answer = 42\n```')
    await settle()
    expect(renderMermaid).not.toHaveBeenCalled()
    expect(e.view.dom.querySelector('[data-node-view-content-react]')?.textContent).toContain(
      'const answer = 42',
    )
    expect(e.getMarkdown().trim()).toBe('```js\nconst answer = 42\n```')
  })

  it('does not insert a late drawing after the source changes', async () => {
    let resolveFirst!: (value: { svg: string }) => void
    renderMermaid.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
    const e = makeEditor('```mermaid\nflowchart LR\n```\n\nAfter')
    await waitFor(() => expect(renderMermaid).toHaveBeenCalledOnce())
    expect(e.view.dom.querySelector('[data-mermaid-diagram]')).not.toBeNull()
    expect(e.view.dom.querySelector('[role="status"]')?.textContent).toContain('Rendering diagram…')
    act(() => {
      e.commands.setTextSelection(3)
      e.view.focus()
    })
    act(() => e.commands.insertContent('changed'))
    act(() => e.commands.setTextSelection(1))
    await settle()
    await act(async () => {
      resolveFirst({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>stale</text></svg>' })
      await Promise.resolve()
    })
    expect(e.view.dom.textContent).not.toContain('stale')
  })
})
