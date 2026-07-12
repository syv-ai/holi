import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { buildDecorations } from '../src/renderer/src/editor/livePreview'

function stateFor(doc: string, cursor = 0) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(cursor),
    extensions: [markdown()],
  })
  ensureSyntaxTree(state, state.doc.length, 5_000)
  return state
}

function specs(set: DecorationSet): { from: number; to: number; spec: Record<string, unknown> }[] {
  const out: { from: number; to: number; spec: Record<string, unknown> }[] = []
  const iter = set.iter()
  while (iter.value) {
    out.push({ from: iter.from, to: iter.to, spec: iter.value.spec as Record<string, unknown> })
    iter.next()
  }
  return out
}

describe('buildDecorations (D22: plain decoration swap)', () => {
  it('conceals heading marks on inactive lines', () => {
    const state = stateFor('# Title\n\nbody text', 12) // caret in body
    const decos = specs(buildDecorations(state, 0, state.doc.length))
    // the "# " HeaderMark (0-2) is concealed
    expect(decos.some((d) => d.from === 0 && d.to === 2)).toBe(true)
  })

  it('reveals raw source on the active line', () => {
    const state = stateFor('# Title\n\nbody text', 3) // caret inside the heading
    const decos = specs(buildDecorations(state, 0, state.doc.length))
    expect(decos.some((d) => d.from === 0 && d.to === 2)).toBe(false)
  })

  it('conceals ** markers around strong text on inactive lines', () => {
    const doc = 'plain\nsome **bold** here'
    const state = stateFor(doc, 0)
    const decos = specs(buildDecorations(state, 0, doc.length))
    const boldStart = doc.indexOf('**')
    expect(decos.some((d) => d.from === boldStart && d.to === boldStart + 2)).toBe(true)
  })

  it('replaces an inactive [[wiki link]] with a chip widget', () => {
    const doc = 'first\nsee [[notes/plan.md]] ok'
    const state = stateFor(doc, 0)
    const decos = specs(buildDecorations(state, 0, doc.length))
    const start = doc.indexOf('[[')
    const end = doc.indexOf(']]') + 2
    const chip = decos.find((d) => d.from === start && d.to === end)
    expect(chip).toBeDefined()
    expect(chip?.spec['widget']).toBeDefined()
  })

  it('reveals the raw [[wiki link]] when the caret is inside it', () => {
    const doc = 'see [[notes/plan.md]] ok'
    const state = stateFor(doc, 8)
    const decos = specs(buildDecorations(state, 0, doc.length))
    expect(decos.some((d) => (d.spec['widget'] as unknown) !== undefined)).toBe(false)
  })
})
