/**
 * The frontmatter widget's decision logic, tested headlessly — no DOM, exactly
 * as live-preview.test.ts tests buildDecorations. The nested editor and the DOM
 * it mounts need a real EditorView (a signed-in app to see); what is pure — the
 * block-replace over the region, the collapse reducer, and livePreview yielding
 * the region — is covered here.
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { buildDecorations } from '../src/renderer/src/editor/livePreview'
import {
  frontmatterDecorations,
  frontmatterExpandedField,
  frontmatterValid,
  regionTextFrom,
  toggleFrontmatter,
} from '../src/renderer/src/editor/frontmatter'

function stateFor(doc: string, extra: Extension[] = []) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(doc.length),
    extensions: [markdown({ base: markdownLanguage }), frontmatterExpandedField, ...extra],
  })
  ensureSyntaxTree(state, state.doc.length, 5_000)
  return state
}

function specs(set: DecorationSet) {
  const out: { from: number; to: number; spec: Record<string, unknown> }[] = []
  const iter = set.iter()
  while (iter.value) {
    out.push({ from: iter.from, to: iter.to, spec: iter.value.spec as Record<string, unknown> })
    iter.next()
  }
  return out
}

const DOC = '---\ntitle: x\n---\n\nbody paragraph'

describe('frontmatterDecorations', () => {
  it('block-replaces the whole region, collapsed by default', () => {
    const decos = specs(frontmatterDecorations(stateFor(DOC)))
    expect(decos).toHaveLength(1)
    expect(decos[0]!.from).toBe(0)
    // The end of the closing `---` line — NOT 17, the start of the body line.
    // A block replace has to end at a line end; ending it one past that put the
    // first body position inside the widget's row and parked the caret there.
    expect(decos[0]!.to).toBe(16)
    expect(decos[0]!.spec.block).toBe(true)
    expect((decos[0]!.spec.widget as { expanded: boolean }).expanded).toBe(false)
  })

  it('reflects the revealed state after a toggle', () => {
    const state = stateFor(DOC).update({ effects: toggleFrontmatter.of(true) }).state
    const widget = specs(frontmatterDecorations(state))[0]!.spec.widget as { expanded: boolean }
    expect(widget.expanded).toBe(true)
  })

  it('emits nothing when there is no frontmatter', () => {
    expect(specs(frontmatterDecorations(stateFor('# just a heading\n\nbody')))).toHaveLength(0)
  })
})

describe('frontmatterExpandedField reducer', () => {
  it('starts collapsed and follows the toggle effect', () => {
    const s0 = stateFor(DOC)
    expect(s0.field(frontmatterExpandedField)).toBe(false)
    const s1 = s0.update({ effects: toggleFrontmatter.of(true) }).state
    expect(s1.field(frontmatterExpandedField)).toBe(true)
    const s2 = s1.update({ effects: toggleFrontmatter.of(false) }).state
    expect(s2.field(frontmatterExpandedField)).toBe(false)
  })
})

describe('livePreview yields the frontmatter region', () => {
  it('emits no decoration over the fenced region (no HR over the --- lines)', () => {
    const decos = specs(buildDecorations(stateFor(DOC), 0, DOC.length))
    // Nothing the live-preview builder emits may fall inside [0, 17): the widget
    // owns that range, and an HR/paragraph decoration there would fight it.
    expect(decos.every((d) => d.from >= 17)).toBe(true)
  })

  it('still decorates the body below the region', () => {
    const doc = '---\ntitle: x\n---\n\n**bold** body'
    const decos = specs(buildDecorations(stateFor(doc), 0, doc.length))
    // the **bold** strong mark is below the region and must still render
    expect(decos.some((d) => (d.spec.class as string | undefined)?.includes('strong'))).toBe(true)
  })
})

describe('frontmatterValid selector + regionTextFrom', () => {
  it('reads validity off the document', () => {
    expect(frontmatterValid(stateFor(DOC))).toBe(true)
    expect(frontmatterValid(stateFor('---\ntags: [a, b\n---\nx'))).toBe(false)
  })

  it('rebuilds a fenced region from a body, keeping fences intact', () => {
    expect(regionTextFrom('title: x\n')).toBe('---\ntitle: x\n---\n')
    expect(regionTextFrom('title: x')).toBe('---\ntitle: x\n---\n')
    expect(regionTextFrom('')).toBe('---\n---\n')
  })
})
