import { Editor, EditorContent } from '@tiptap/react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createStore, Provider } from 'jotai'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocumentExtensions } from '../document-extensions'
import { colorSchemeAtom } from '@/state/color-scheme'

const draw = vi.hoisted(() => vi.fn())
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: draw } }))

const diagram = '```mermaid\nflowchart LR\nA --> B\n```'
const picture = '![Map](../assets/map.png)'
const svg = (label: string) => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 100"><text>${label}</text></svg>`,
})
let editor: Editor | null = null
let view: ReturnType<typeof render> | null = null
let store: ReturnType<typeof createStore>

beforeEach(() => {
  store = createStore()
  store.set(colorSchemeAtom, 'light')
  draw.mockReset().mockResolvedValue(svg('ready'))
})
afterEach(() => {
  view?.unmount()
  view = null
  act(() => editor?.destroy())
  editor = null
})

function mount(markdown: string, editable = true) {
  editor = new Editor({
    extensions: createDocumentExtensions({
      folder: 'notes',
      placeholder: '',
      onOpenLink: () => {},
    }),
    content: markdown,
    contentType: 'markdown',
    editable,
    editorProps: { handleScrollToSelection: () => true },
  })
  view = render(createElement(Provider, { store }, createElement(EditorContent, { editor })))
  return editor
}

describe('rendered media inspection through the document editor', () => {
  it.each([
    [picture, 'Map', true],
    [picture, 'Map', false],
    [diagram, 'Mermaid diagram', true],
    [diagram, 'Mermaid diagram', false],
  ] as const)(
    'preserves document, undo and focus for %s (%s, editable %s)',
    async (content, title, editable) => {
      const user = userEvent.setup()
      const e = mount(content, editable)
      if (title === 'Mermaid diagram') await waitFor(() => expect(draw).toHaveBeenCalledOnce())
      const trigger = await screen.findByRole('button', { name: `Open ${title}` })
      const before = e.getMarkdown()
      const doc = e.state.doc
      const updated = vi.fn()
      e.on('update', updated)
      expect(e.isEditable).toBe(editable)
      await user.click(trigger)
      expect(await screen.findByRole('dialog', { name: title })).toBeTruthy()
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(trigger))
      expect(e.state.doc).toBe(doc)
      expect(e.getMarkdown()).toBe(before)
      expect(updated).not.toHaveBeenCalled()
      expect(e.can().undo()).toBe(false)
      if (!editable) expect(screen.queryByRole('button', { name: 'Edit source' })).toBeNull()
    },
  )

  it.each([
    [picture, 'Map', '{Enter}'],
    [picture, 'Map', ' '],
    [diagram, 'Mermaid diagram', '{Enter}'],
    [diagram, 'Mermaid diagram', ' '],
  ])('opens %s using only %s keyboard activation', async (content, title, key) => {
    const user = userEvent.setup()
    mount(content)
    const trigger = await screen.findByRole('button', { name: `Open ${title}` })
    act(() => trigger.focus())
    await user.keyboard(key)
    expect(await screen.findByRole('dialog', { name: title })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('clears the old drawing and announces a theme redraw inside an open lightbox', async () => {
    const user = userEvent.setup()
    let resolve!: (value: { svg: string }) => void
    mount(diagram)
    await waitFor(() => expect(document.querySelector('[data-mermaid-diagram] svg')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Open Mermaid diagram' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('svg text')?.textContent).toBe('ready')
    draw.mockImplementationOnce(() => new Promise((done) => (resolve = done)))
    act(() => store.set(colorSchemeAtom, 'dark'))
    await waitFor(() => expect(draw).toHaveBeenCalledTimes(2))
    expect(dialog.querySelector('svg text')).toBeNull()
    expect(within(dialog).getByRole('status').textContent).toContain('Rendering diagram')
    await act(async () => resolve(svg('redrawn')))
    await waitFor(() => expect(dialog.querySelector('svg text')?.textContent).toBe('redrawn'))
  })

  it.each(['mouse', 'keyboard'])(
    'retries a read-only pending inspection with %s without writing',
    async (input) => {
      const user = userEvent.setup()
      let reject!: (reason: Error) => void
      draw.mockImplementationOnce(() => new Promise((_done, fail) => (reject = fail)))
      const e = mount(diagram, false)
      await waitFor(() => expect(draw).toHaveBeenCalledOnce())
      // Finish editor initialization before measuring the inspection interaction.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const before = e.getMarkdown()
      const updated = vi.fn()
      e.on('update', updated)
      await user.click(screen.getByRole('button', { name: 'Open Mermaid diagram' }))
      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByRole('status').textContent).toContain('Rendering diagram')
      await act(async () => reject(new Error('temporary rendering failure')))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.getByRole('status').textContent).toContain("Couldn't draw this diagram")
      const retry = screen.getByRole('button', { name: 'Retry' })
      if (input === 'keyboard') {
        act(() => retry.focus())
        expect(e.getMarkdown(), 'after focusing Retry').toBe(before)
        await user.keyboard('{Enter}')
      } else {
        await user.click(retry)
      }
      await waitFor(() => expect(document.querySelector('[data-mermaid-diagram] svg')).toBeTruthy())
      expect(screen.queryByRole('button', { name: 'Edit source' })).toBeNull()
      expect(e.getMarkdown()).toBe(before)
      expect(updated).not.toHaveBeenCalled()
      expect(e.can().undo()).toBe(false)
    },
  )

  it('keeps explicit source editing and undo functional', async () => {
    const user = userEvent.setup()
    const e = mount(diagram)
    await waitFor(() => expect(document.querySelector('[data-mermaid-diagram] svg')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Edit source' }))
    await waitFor(() => expect(e.view.hasFocus()).toBe(true))
    expect(e.state.doc.resolve(e.state.selection.from).parent.type.name).toBe('codeBlock')
    const before = e.getMarkdown()
    await user.keyboard('X')
    expect(e.getMarkdown()).not.toBe(before)
    act(() => {
      e.commands.undo()
    })
    expect(e.getMarkdown()).toBe(before)
  })

  it('uses only sanitized SVG in the larger view', async () => {
    const user = userEvent.setup()
    draw.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)"><text>safe label</text></a></svg>',
    })
    mount(diagram, false)
    await waitFor(() => expect(document.querySelector('[data-mermaid-diagram] svg')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Open Mermaid diagram' }))
    const dialog = await screen.findByRole('dialog')
    const drawing = dialog.querySelector('svg')!
    expect(drawing).toBeTruthy()
    expect(drawing.hasAttribute('onload')).toBe(false)
    expect(drawing.querySelector('script,a,[href],[onload]')).toBeNull()
    expect(drawing.textContent).toContain('safe label')
  })

  it('removes an open lightbox when its document node disappears', async () => {
    const user = userEvent.setup()
    const e = mount(diagram)
    await user.click(await screen.findByRole('button', { name: 'Open Mermaid diagram' }))
    await screen.findByRole('dialog')
    act(() =>
      e.commands.setContent('Replacement paragraph', {
        contentType: 'markdown',
        emitUpdate: false,
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
    expect(e.getMarkdown().trim()).toBe('Replacement paragraph')
  })

  it('unmounts an inspected image without leaving a portal or focus trap', async () => {
    const user = userEvent.setup()
    mount(picture)
    await user.click(screen.getByRole('button', { name: 'Open Map' }))
    await screen.findByRole('dialog')
    view?.unmount()
    view = null
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
  })

  it('resolves relative images without changing Markdown and recovers from a preview error', async () => {
    const user = userEvent.setup()
    const e = mount(picture)
    const before = e.getMarkdown()
    const origin = screen.getByRole('button', { name: 'Open Map' })
    expect(origin.querySelector('img')?.getAttribute('src')).toBe(
      'holi-vault://vault/assets/map.png',
    )
    const inline = origin.querySelector('img')
    await user.click(origin)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Loading image')).toBeTruthy()
    fireEvent.error(dialog.querySelector('img')!)
    expect(within(dialog).getByRole('status').textContent).toContain("Couldn't load image")
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }))
    // Reload the failed inline request too, not just the enlarged image.
    expect(origin.querySelector('img')).not.toBe(inline)
    fireEvent.load(dialog.querySelector('img')!)
    expect(within(dialog).queryByLabelText('Loading image')).toBeNull()
    expect(e.getMarkdown()).toBe(before)
    expect(e.can().undo()).toBe(false)
  })
})
