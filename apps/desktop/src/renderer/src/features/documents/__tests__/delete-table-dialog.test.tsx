import { Editor } from '@tiptap/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { DeleteTableDialog } from '../rich-text/delete-table-dialog'
import { createDocumentExtensions } from '../document-extensions'
import { RichTextTable } from '../rich-text/rich-text-table'

let editor: Editor | null = null
afterEach(async () => {
  await act(async () => {
    cleanup()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  editor?.destroy()
  editor = null
})

function makeTable(text: string) {
  return {
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
          },
        ],
      },
    ],
  }
}

function open(content: object[]) {
  editor = new Editor({
    extensions: [
      ...createDocumentExtensions({ folder: '', placeholder: '', onOpenLink: () => undefined }),
      RichTextTable,
    ],
    content: { type: 'doc', content },
  })
  return editor
}

function selectText(ed: Editor, text: string) {
  let position = -1
  ed.state.doc.descendants((node, pos) => {
    if (position === -1 && node.isText && node.text === text) position = pos
  })
  if (position < 0) throw new Error(`Missing text: ${text}`)
  ed.commands.setTextSelection(position)
}

function confirmDelete(ed: Editor) {
  render(<DeleteTableDialog editor={ed} open onOpenChange={() => undefined} />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete Table' }))
}

describe('DeleteTableDialog', () => {
  it('removes a captioned table and undo restores the table and caption', async () => {
    const ed = open([
      {
        type: 'documentFigure',
        content: [
          makeTable('cell content'),
          { type: 'documentCaption', content: [{ type: 'text', text: 'Table caption' }] },
        ],
      },
    ])
    selectText(ed, 'cell content')

    confirmDelete(ed)

    await waitFor(() => expect(ed.state.doc.textContent).not.toContain('cell content'))
    expect(ed.state.doc.textContent).not.toContain('Table caption')
    expect(ed.state.doc.toJSON().content?.some((node) => node.type === 'documentFigure')).toBe(
      false,
    )
    expect(ed.commands.undo()).toBe(true)
    expect(ed.state.doc.textContent).toContain('cell content')
    expect(ed.state.doc.textContent).toContain('Table caption')
    expect(ed.state.doc.toJSON().content?.some((node) => node.type === 'documentFigure')).toBe(true)
  })

  it('deletes only a nested table, keeping its outer captioned table', async () => {
    const ed = open([
      {
        type: 'documentFigure',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    content: [
                      { type: 'paragraph', content: [{ type: 'text', text: 'outer cell' }] },
                      makeTable('inner cell'),
                    ],
                  },
                ],
              },
            ],
          },
          { type: 'documentCaption', content: [{ type: 'text', text: 'Outer caption' }] },
        ],
      },
    ])
    selectText(ed, 'inner cell')

    confirmDelete(ed)

    await waitFor(() => expect(ed.state.doc.textContent).not.toContain('inner cell'))
    expect(ed.state.doc.textContent).toContain('outer cell')
    expect(ed.state.doc.textContent).toContain('Outer caption')
    const tableTypes: string[] = []
    ed.state.doc.descendants((node) => {
      if (node.type.name === 'table') tableTypes.push(node.type.name)
    })
    expect(tableTypes).toHaveLength(1)
  })
})
