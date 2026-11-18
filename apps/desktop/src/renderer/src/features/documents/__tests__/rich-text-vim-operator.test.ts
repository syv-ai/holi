import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { describe, expect, it } from 'vitest'
import { planVimOperator, type VimOperatorRequest } from '../rich-text-vim-operator'
import { TaskList } from '@tiptap/extension-list'
import { RichTextTaskItem } from '../rich-text/rich-text-task-item'

function withEditor(content: string, run: (editor: Editor) => void, structured = false) {
  const editor = new Editor({
    extensions: [
      StarterKit,
      ...(structured ? [TableKit, TaskList, RichTextTaskItem.configure({ nested: true })] : []),
    ],
    content,
  })
  try {
    run(editor)
  } finally {
    editor.destroy()
  }
}

describe('planVimOperator', () => {
  it('returns result-document carets for deletion and insertion without mutating state', () => {
    withEditor('<p>one</p>', (editor) => {
      const sourceDoc = editor.state.doc
      for (const operator of ['d', 'c'] as const) {
        const plan = planVimOperator(editor.state, {
          operator,
          target: { kind: 'motion', origin: 2, motion: '$', count: 1 },
        })
        expect(plan.kind).toBe('ready')
        if (plan.kind !== 'ready' || !plan.mutation) throw new Error('expected a mutation plan')
        const edits = plan.mutation.kind === 'sequence' ? plan.mutation.edits : [plan.mutation]
        const tr = editor.state.tr
        for (const edit of edits) {
          if (edit.kind === 'delete') tr.delete(edit.range.from, edit.range.to)
          else tr.replaceWith(edit.range.from, edit.range.to, edit.replacement.content)
        }
        expect(tr.doc.textContent).toBe('o')
        expect(plan.caret).toEqual({
          position: operator === 'd' ? 1 : 2,
          bias: 1,
          mode: operator === 'd' ? 'normal' : 'insert',
        })
        expect(tr.doc.resolve(plan.caret.position).parent.isTextblock).toBe(true)
        expect(editor.state.doc).toBe(sourceDoc)
      }
    })
  })

  it('plans without mutating editor state and exposes the exact source document', () => {
    withEditor('<p><strong>alpha</strong> beta</p><p>next</p>', (editor) => {
      const state = editor.state
      const doc = state.doc
      const selection = state.selection
      const request: VimOperatorRequest = {
        operator: 'd',
        target: { kind: 'motion', origin: 1, motion: 'w', count: 1 },
      }
      const plan = planVimOperator(state, request)
      expect(state.doc).toBe(doc)
      expect(state.selection).toBe(selection)
      expect(plan.kind).toBe('ready')
      if (plan.kind !== 'ready') return
      expect(plan.sourceDoc).toBe(doc)
      expect(plan.register.content.content.toJSON()).toEqual([
        { type: 'text', marks: [{ type: 'bold' }], text: 'alpha' },
        { type: 'text', text: ' ' },
      ])
      expect(plan.mutation).toEqual({ kind: 'delete', range: { from: 1, to: 7 } })
      if (plan.mutation?.kind !== 'delete') throw new Error('expected a deletion plan')
      const tr = state.tr.delete(plan.mutation.range.from, plan.mutation.range.to)
      expect(tr.doc.check()).toBeUndefined()
      expect(tr.doc.textContent).toBe('betanext')
      expect(plan.caret.position).toBeGreaterThanOrEqual(0)
      expect(plan.caret.position).toBeLessThanOrEqual(tr.doc.content.size)
    })
  })

  it('rejects doubled and vertical ranges that would include unselected logical lines', () => {
    for (const content of [
      '<p>keep<br>delete</p><p>next</p>',
      '<pre><code>keep\ndelete</code></pre><p>next</p>',
    ]) {
      withEditor(content, (editor) => {
        let origin = -1
        editor.state.doc.descendants((node, pos) => {
          const offset = node.isText ? (node.text?.indexOf('delete') ?? -1) : -1
          if (offset >= 0) origin = pos + offset
        })
        expect(origin).toBeGreaterThan(0)
        for (const operator of ['d', 'c', 'y'] as const) {
          for (const target of [
            { kind: 'doubled' as const, origin, count: 2 },
            { kind: 'motion' as const, origin, motion: 'j' as const, count: 1 },
          ]) {
            expect(planVimOperator(editor.state, { operator, target }).kind).toBe('rejected')
          }
        }
      })
    }
  })

  it('counts doubled operators across global logical lines and rejects partial blocks', () => {
    for (const content of [
      '<p>before</p><pre><code>first\nsecond</code></pre><p>after</p>',
      '<p>before</p><p>first<br>second</p><p>after</p>',
    ])
      withEditor(content, (editor) => {
        let origin = 0
        editor.state.doc.descendants((node, pos) => {
          if (node.isText && node.text === 'before') origin = pos
        })
        for (const operator of ['d', 'c', 'y'] as const) {
          const partial = planVimOperator(editor.state, {
            operator,
            target: { kind: 'doubled', origin, count: 2 },
          })
          expect(partial.kind).toBe('rejected')
        }
        const plan = planVimOperator(editor.state, {
          operator: 'd',
          target: { kind: 'doubled', origin, count: 3 },
        })
        expect(plan.kind).toBe('ready')
        if (plan.kind !== 'ready' || !plan.mutation) return
        const edits = plan.mutation.kind === 'sequence' ? plan.mutation.edits : [plan.mutation]
        const tr = editor.state.tr
        for (const edit of edits) {
          if (edit.kind === 'delete') tr.delete(edit.range.from, edit.range.to)
          else tr.replaceWith(edit.range.from, edit.range.to, edit.replacement.content)
        }
        expect(tr.doc.toJSON()).toEqual({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'after' }] }],
        })
      })
  })

  it('returns no-op and rejected plans without changing source state', () => {
    withEditor(
      '<p>word</p><table><tbody><tr><td><p>cell</p></td><td><p>other</p></td></tr></tbody></table>',
      (editor) => {
        const doc = editor.state.doc
        const noop = planVimOperator(editor.state, {
          operator: 'd',
          target: { kind: 'motion', origin: -1, motion: 'w', count: 1 },
        })
        expect(noop.kind).toBe('noop')
        let cell = 0
        editor.state.doc.descendants((node, pos) => {
          if (node.isText && node.text === 'cell') cell = pos
        })
        const rejected = planVimOperator(editor.state, {
          operator: 'c',
          target: { kind: 'motion', origin: cell, motion: 'w', count: 2 },
        })
        expect(rejected.kind).toBe('rejected')
        expect(editor.state.doc).toBe(doc)
      },
      true,
    )
  })

  it('keeps every ready mutation inside its native structural container', () => {
    for (const content of [
      '<pre><code>first\nsecond\nthird</code></pre>',
      '<p>first<br>second<br>third</p>',
      '<ul><li><p>first</p><p>second</p></li><li><p>third</p></li></ul>',
      '<table><tbody><tr><td><p>first</p><p>second</p></td><td><p>other</p></td></tr></tbody></table>',
    ]) {
      withEditor(
        content,
        (editor) => {
          let origin = 0
          editor.state.doc.descendants((node, pos) => {
            if (node.isText && node.text && origin === 0) origin = pos
          })
          const requests: VimOperatorRequest[] = [
            { operator: 'd', target: { kind: 'doubled', origin, count: 1 } },
            { operator: 'c', target: { kind: 'motion', origin, motion: 'w', count: 1 } },
            {
              operator: 'y',
              target: { kind: 'visual', anchor: origin, cursor: origin + 2, linewise: false },
            },
          ]
          for (const request of requests) {
            const plan = planVimOperator(editor.state, request)
            if (plan.kind !== 'ready' || !plan.mutation) continue
            const edits = plan.mutation.kind === 'sequence' ? plan.mutation.edits : [plan.mutation]
            const tr = editor.state.tr
            for (const edit of edits) {
              expect(edit.range.from).toBeGreaterThanOrEqual(0)
              expect(edit.range.to).toBeLessThanOrEqual(editor.state.doc.content.size)
              if (edit.kind === 'delete') tr.delete(edit.range.from, edit.range.to)
              else tr.replaceWith(edit.range.from, edit.range.to, edit.replacement.content)
            }
            expect(tr.doc.check()).toBeUndefined()
          }
        },
        true,
      )
    }
  })

  it('clips extreme counts and handles bounded operator-target-shape combinations', () => {
    const contents = [
      '<p>one two</p>',
      '<pre><code>one\ntwo</code></pre>',
      '<p>one<br>two</p>',
      '<p></p>',
    ]
    for (const content of contents) {
      withEditor(content, (editor) => {
        let origin = 0
        editor.state.doc.descendants((node, pos) => {
          if (node.isText && node.text && origin === 0) origin = pos
        })
        for (const operator of ['d', 'c', 'y'] as const) {
          for (const count of [1, 2, 999, 1000]) {
            for (const target of [
              { kind: 'doubled' as const, origin, count },
              { kind: 'motion' as const, origin, motion: 'w' as const, count },
              { kind: 'visual' as const, anchor: origin, cursor: origin + count, linewise: true },
            ]) {
              const doc = editor.state.doc
              const plan = planVimOperator(editor.state, { operator, target })
              expect(editor.state.doc).toBe(doc)
              if (plan.kind === 'ready') {
                expect(plan.sourceDoc).toBe(doc)
                expect(plan.contentRange.from).toBeGreaterThanOrEqual(0)
                expect(plan.contentRange.to).toBeLessThanOrEqual(doc.content.size)
                if (plan.mutation) {
                  const edits =
                    plan.mutation.kind === 'sequence' ? plan.mutation.edits : [plan.mutation]
                  for (const edit of edits) {
                    expect(edit.range.from).toBeGreaterThanOrEqual(0)
                    expect(edit.range.to).toBeLessThanOrEqual(doc.content.size)
                  }
                }
              }
            }
          }
        }
      })
    }
  })
})
