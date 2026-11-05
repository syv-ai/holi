import { Editor, EditorContent } from '@tiptap/react'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyseMermaidLabels } from '@holi/shared'
import { Provider, createStore } from 'jotai'
import { activeRemoteAtom } from '@/state/vaults'

const renderDiagram = vi.hoisted(() => vi.fn())
vi.mock('@/lib/mermaid-renderer', () => ({ renderMermaid: renderDiagram }))

import { createDocumentExtensions } from '../document-extensions'

let editor: Editor | null = null

function drawing(source: string) {
  const analysis = analyseMermaidLabels(source)
  const labels = analysis.supported ? analysis.labels : []
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const label of labels) {
    const group = document.createElementNS(svg.namespaceURI, 'g')
    group.setAttribute('id', `node-${label.id}`)
    group.setAttribute('class', 'node')
    const text = document.createElementNS(svg.namespaceURI, 'text')
    text.setAttribute('class', 'label')
    text.textContent = label.label
    group.append(text)
    svg.append(group)
  }
  return {
    svg: new XMLSerializer().serializeToString(svg),
    targets: labels.map(({ id, label }) => ({ id, label, domId: `node-${id}` })),
  }
}

beforeEach(() => {
  renderDiagram.mockReset().mockImplementation(async (source: string) => drawing(source))
})

afterEach(() => {
  act(() => editor?.destroy())
  editor = null
})

describe('editing labels in the rendered Mermaid drawing', () => {
  it('activates the connected SVG label and opens its anchored field', async () => {
    editor = new Editor({
      extensions: createDocumentExtensions({
        folder: 'notes',
        placeholder: '',
        onOpenLink: () => undefined,
      }),
      content: 'Before\n\n```mermaid\nflowchart LR\nA[Alpha] --> B[Beta]\n```\n\nAfter',
      contentType: 'markdown',
    })
    render(createElement(EditorContent, { editor }))
    await waitFor(() => expect(editor?.view.dom.querySelector('svg')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Edit labels' }))
    const target = await screen.findByRole('button', { name: 'Alpha (A)' })
    expect(target.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(target.isConnected).toBe(true)
    fireEvent.click(target)
    expect(await screen.findByRole('textbox', { name: 'Alpha (A)' })).toHaveValue('Alpha')
    expect(editor.getMarkdown()).toContain('A[Alpha] --> B[Beta]')
  })

  it('rejects a vault switch while label validation is pending', async () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'owner/first')
    let resolveValidation: ((value: ReturnType<typeof drawing>) => void) | undefined
    renderDiagram.mockImplementation((source: string) => {
      if (source.includes('Gamma'))
        return new Promise((resolve) => {
          resolveValidation = resolve
        })
      return Promise.resolve(drawing(source))
    })
    editor = new Editor({
      extensions: createDocumentExtensions({
        folder: 'notes',
        placeholder: '',
        onOpenLink: () => undefined,
      }),
      content: '```mermaid\nflowchart LR\nA[Alpha] --> B[Beta]\n```',
      contentType: 'markdown',
    })
    render(
      <Provider store={store}>
        <EditorContent editor={editor} />
      </Provider>,
    )
    await waitFor(() => expect(editor?.view.dom.querySelector('svg')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Edit labels' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Alpha (A)' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Alpha (A)' }), {
      target: { value: 'Gamma' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(resolveValidation).toBeDefined())
    act(() => store.set(activeRemoteAtom, 'owner/second'))
    await act(async () => {
      resolveValidation?.(drawing('flowchart LR\nA[Gamma] --> B[Beta]'))
    })
    expect(editor.getMarkdown()).toContain('A[Alpha] --> B[Beta]')
    expect(editor.getMarkdown()).not.toContain('A[Gamma]')
  })
})
