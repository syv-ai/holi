import { Editor, EditorContent } from '@tiptap/react'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyseMermaidLabels } from '@holi/shared'

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
})
