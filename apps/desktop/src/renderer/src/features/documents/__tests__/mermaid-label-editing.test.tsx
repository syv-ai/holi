import { Editor, EditorContent } from '@tiptap/react'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyseMermaidLabels } from '@holi/shared'
import { Provider, createStore } from 'jotai'
import { activeRemoteAtom } from '@/state/vaults'
import { colorSchemeAtom } from '@/state/color-scheme'

const renderDiagram = vi.hoisted(() => vi.fn())
vi.mock('@/lib/mermaid-renderer', () => ({ renderMermaid: renderDiagram }))

import { createDocumentExtensions } from '../document-extensions'

let editor: Editor | null = null
const markdown = 'Before\n\n```mermaid\nflowchart LR\nA[Alpha] --> B[Beta]\n```\n\nAfter'

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

async function open(text = markdown) {
  const store = createStore()
  store.set(activeRemoteAtom, 'owner/first')
  store.set(colorSchemeAtom, 'light')
  const updates = vi.fn()
  const e = new Editor({
    extensions: createDocumentExtensions({
      folder: 'notes',
      placeholder: '',
      onOpenLink: () => undefined,
    }),
    content: text,
    contentType: 'markdown',
    // jsdom has no caret layout; native checks exercise scrolling and keyboard undo.
    editorProps: { handleScrollToSelection: () => true },
    onUpdate: updates,
  })
  editor = e
  const view = render(
    <Provider store={store}>
      <EditorContent editor={e} />
    </Provider>,
  )
  await waitFor(() => expect(e.view.dom.querySelector('svg')).not.toBeNull())
  await screen.findByRole('button', { name: 'Edit labels' })
  updates.mockClear()
  return { e, store, view, updates }
}

async function labelField(name = 'Alpha') {
  fireEvent.click(screen.getByRole('button', { name: 'Edit labels' }))
  const target = await screen.findByRole('button', { name })
  expect(target.namespaceURI).toBe('http://www.w3.org/2000/svg')
  expect(target.isConnected).toBe(true)
  fireEvent.click(target)
  return await screen.findByRole('textbox', { name })
}

function blockPosition(e: Editor) {
  let position = -1
  e.state.doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') position = pos
  })
  if (position < 0) throw new Error('Missing diagram node')
  return position
}

function pendingValidation() {
  let resolve!: (value: ReturnType<typeof drawing>) => void
  const promise = new Promise<ReturnType<typeof drawing>>((done) => {
    resolve = done
  })
  renderDiagram.mockReturnValueOnce(promise)
  return async () => {
    const source = renderDiagram.mock.calls.at(-1)![0] as string
    await act(async () => {
      resolve(drawing(source))
    })
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
    const { e } = await open()
    expect(await labelField()).toHaveValue('Alpha')
    expect(e.getMarkdown()).toContain('A[Alpha] --> B[Beta]')
  })

  it('keeps a single preview click non-destructive and opens inspection on double-click', async () => {
    const { e, updates } = await open()
    const original = e.state.doc
    const selection = e.state.selection.toJSON()
    const diagram = document.querySelector('[data-mermaid-diagram]')!
    fireEvent.click(diagram)
    expect(document.querySelector('[data-mermaid-diagram]')).toBe(diagram)
    expect(e.state.doc).toBe(original)
    expect(e.state.selection.toJSON()).toEqual(selection)
    expect(updates).not.toHaveBeenCalled()
    expect(e.can().undo()).toBe(false)

    fireEvent.doubleClick(diagram)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(e.state.doc).toBe(original)
    expect(updates).not.toHaveBeenCalled()
    expect(e.can().undo()).toBe(false)
  })

  it('keeps toolbar mousedown outside ProseMirror selection handling', async () => {
    const { e } = await open()
    const selection = e.state.selection.toJSON()
    const button = screen.getByRole('button', { name: 'Edit labels' })
    expect(button.closest('[contenteditable="false"]')).not.toBeNull()
    fireEvent.mouseDown(button)
    fireEvent.click(button)
    expect(e.state.selection.toJSON()).toEqual(selection)
    expect(await screen.findByRole('button', { name: 'Alpha' })).toBeInTheDocument()
  })

  it('applies only the label, serializes Markdown and keeps the drawing visible', async () => {
    const { e, updates } = await open()
    const original = e.getMarkdown()
    fireEvent.change(await labelField(), { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(e.getMarkdown()).toBe(original.replace('A[Alpha]', 'A[Gamma]')))
    await waitFor(() => expect(e.view.dom.querySelector('svg')).not.toBeNull())
    expect(updates).toHaveBeenCalledOnce()
    expect(screen.queryByRole('textbox', { name: 'Alpha' })).not.toBeInTheDocument()
  })

  it.each([
    ['AlphaAlpha', 'Alpha'],
    ['aaaa', 'a'],
    ['ababa', 'aba'],
  ])('shortens %s to %s without overlapping prefix and suffix ranges', async (before, after) => {
    const { e, updates } = await open(markdown.replace('A[Alpha]', `A[${before}]`))
    fireEvent.change(await labelField(`${before}`), { target: { value: after } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(e.getMarkdown()).toBe(markdown.replace('A[Alpha]', `A[${after}]`)))
    expect(updates).toHaveBeenCalledOnce()
  })

  it('rejects a same-task Provider vault switch before Apply', async () => {
    const { e, store, updates } = await open()
    fireEvent.change(await labelField(), { target: { value: 'Gamma' } })
    const original = e.state.doc
    act(() => {
      store.set(activeRemoteAtom, 'owner/second')
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(e.state.doc).toBe(original)
    expect(updates).not.toHaveBeenCalled()
  })

  it('rejects a vault switch while validation is pending', async () => {
    const { e, store, updates } = await open()
    fireEvent.change(await labelField(), { target: { value: 'Gamma' } })
    const complete = pendingValidation()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const original = e.state.doc
    act(() => store.set(activeRemoteAtom, 'owner/second'))
    await complete()
    expect(e.state.doc).toBe(original)
    expect(updates).not.toHaveBeenCalled()
  })

  it.each([
    'same-text replacement',
    'source change',
    'deletion',
    'read-only',
    'silent read-only',
    'unmount',
  ] as const)(
    'discards pending validation after %s without a late update or focus',
    async (change) => {
      const { e, view, updates } = await open()
      act(() => e.commands.setNodeSelection(blockPosition(e)))
      fireEvent.change(await labelField(), { target: { value: 'Gamma' } })
      const complete = pendingValidation()
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      const position = blockPosition(e)
      const node = e.state.doc.nodeAt(position)!
      act(() => {
        if (change === 'same-text replacement')
          e.view.dispatch(
            e.state.tr.replaceWith(
              position,
              position + node.nodeSize,
              e.schema.nodeFromJSON(node.toJSON()),
            ),
          )
        if (change === 'source change')
          e.view.dispatch(e.state.tr.insertText(' changed', position + 1 + node.textContent.length))
        if (change === 'deletion')
          e.view.dispatch(e.state.tr.delete(position, position + node.nodeSize))
        if (change === 'read-only') e.setEditable(false)
        if (change === 'silent read-only') e.setEditable(false, false)
        if (change === 'unmount') view.unmount()
      })
      if (change === 'same-text replacement') expect(e.state.doc.nodeAt(position)).not.toBe(node)
      const expected = e.state.doc
      updates.mockClear()
      const focus = vi.spyOn(e.view, 'focus')
      await complete()
      expect(e.state.doc).toBe(expected)
      expect(updates).not.toHaveBeenCalled()
      expect(focus).not.toHaveBeenCalled()
      expect(screen.queryByRole('textbox', { name: 'Alpha' })).not.toBeInTheDocument()
    },
  )

  it('allows an unchanged target to move after a preceding document edit', async () => {
    const { e } = await open()
    fireEvent.change(await labelField(), { target: { value: 'Gamma' } })
    const complete = pendingValidation()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const position = blockPosition(e)
    const node = e.state.doc.nodeAt(position)
    act(() => e.view.dispatch(e.state.tr.insertText('prefix ', 1)))
    expect(e.state.doc.nodeAt(blockPosition(e))).toBe(node)
    expect(blockPosition(e)).toBeGreaterThan(position)
    await complete()
    await waitFor(() => expect(e.getMarkdown()).toContain('A[Gamma] --> B[Beta]'))
    expect(e.getMarkdown()).toContain('prefix Before')
    expect(e.getMarkdown()).toContain('After')
  })

  it.each(['Cancel', 'Escape'] as const)('discards draft text on %s', async (action) => {
    const { e, updates } = await open()
    const original = e.state.doc
    const field = await labelField()
    fireEvent.change(field, { target: { value: 'Gamma' } })
    if (action === 'Cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    else fireEvent.keyDown(field, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Alpha' })).not.toBeInTheDocument(),
    )
    expect(e.state.doc).toBe(original)
    expect(updates).not.toHaveBeenCalled()
  })

  it.each(['Enter', ' '] as const)(
    'opens a label with %s and returns focus on Escape',
    async (key) => {
      await open()
      fireEvent.click(screen.getByRole('button', { name: 'Edit labels' }))
      const target = await screen.findByRole('button', { name: 'Alpha' })
      target.focus()
      fireEvent.keyDown(target, { key })
      const field = await screen.findByRole('textbox', { name: 'Alpha' })
      fireEvent.keyDown(field, { key: 'Escape' })
      await waitFor(() => expect(target).toHaveFocus())
    },
  )

  it('edits the selected identity when two nodes have the same wording', async () => {
    const { e } = await open(markdown.replace('B[Beta]', 'B[Alpha]'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit labels' }))
    const secondNode = await waitFor(() => {
      const node = document.querySelector('[data-mermaid-source-id="node-B"]')
      if (!node) throw new Error('Second editable Mermaid node is missing')
      return node
    })
    fireEvent.click(secondNode)
    const field = await screen.findByRole('textbox', { name: 'Alpha' })
    fireEvent.change(field, { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(e.getMarkdown()).toContain('A[Alpha] --> B[Gamma]'))
  })

  it('does not add an update/history step for an unchanged label', async () => {
    const { e, updates } = await open()
    const original = e.state.doc
    await labelField()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(e.state.doc).toBe(original)
    expect(updates).not.toHaveBeenCalled()
    expect(e.can().undo()).toBe(false)
  })

  it('does not apply a composing Enter but applies an ordinary Enter', async () => {
    const { e } = await open()
    const field = await labelField()
    fireEvent.change(field, { target: { value: 'Gamma' } })
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    expect(e.getMarkdown()).toContain('A[Alpha]')
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(e.getMarkdown()).toContain('A[Gamma]'))
  })

  it('invalidates an older draft validation when the field changes', async () => {
    const { e } = await open()
    const field = await labelField()
    fireEvent.change(field, { target: { value: 'Gamma' } })
    const complete = pendingValidation()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.change(field, { target: { value: 'Delta' } })
    await complete()
    expect(e.getMarkdown()).toContain('A[Alpha]')
    expect(field).toHaveValue('Delta')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(e.getMarkdown()).toContain('A[Delta]'))
  })

  it('closes an anchored field when the theme replaces its drawing', async () => {
    const { store } = await open()
    await labelField()
    act(() => store.set(colorSchemeAtom, 'dark'))
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Alpha' })).not.toBeInTheDocument(),
    )
  })

  it('separates label undo/redo from preceding and subsequent typing', async () => {
    const { e } = await open()
    act(() => e.commands.insertContentAt(1, 'prior '))
    fireEvent.change(await labelField(), { target: { value: 'GammaZ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(e.getMarkdown()).toContain('A[GammaZ]'))
    const source = e.state.doc.nodeAt(blockPosition(e))!.textContent
    const end = blockPosition(e) + 1 + source.indexOf('GammaZ') + 'GammaZ'.length
    act(() => e.commands.insertContentAt(end, ' after'))
    act(() => e.commands.undo())
    expect(e.getMarkdown()).toContain('A[GammaZ]')
    expect(e.getMarkdown()).not.toContain(' after')
    act(() => e.commands.undo())
    expect(e.getMarkdown()).toContain('A[Alpha]')
    expect(e.getMarkdown()).toContain('prior Before')
    act(() => e.commands.undo())
    expect(e.getMarkdown()).not.toContain('prior ')
    act(() => {
      e.commands.redo()
      e.commands.redo()
      e.commands.redo()
    })
    expect(e.getMarkdown()).toContain('A[GammaZ after]')
    expect(e.getMarkdown()).toContain('prior Before')
  })
})
