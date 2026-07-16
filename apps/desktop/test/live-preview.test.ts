import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { buildDecorations, taskInfoFacet } from '../src/renderer/src/editor/livePreview'
import type { WikiLinkChip } from '../src/renderer/src/editor/wikiLinkChips'

function stateFor(doc: string, cursor = 0, extra: Extension[] = []) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(cursor),
    extensions: [markdown(), ...extra],
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

/**
 * Task chips (D27). The `@`-mention has always inserted `[[task:<id>]]`, and the editor
 * has always dropped it on the floor — the insert path and the render path disagreed, so
 * the app wrote text it would not render.
 */
describe('buildDecorations — [[task:<id>]] chips', () => {
  const known = taskInfoFacet.of((id) =>
    id === 't1' ? { label: 'Ship the thing', missing: false } : { label: '[deleted task]', missing: true },
  )

  const chipIn = (doc: string, extra: Extension[]): WikiLinkChip | undefined => {
    const state = stateFor(doc, 0, extra)
    const found = specs(buildDecorations(state, 0, doc.length)).find((d) => d.spec['widget'])
    return found?.spec['widget'] as WikiLinkChip | undefined
  }

  it('renders a task chip titled by the resolver, not by its id', () => {
    const chip = chipIn('first\nsee [[task:t1]] ok', [known])
    expect(chip).toMatchObject({ kind: 'task', target: 't1', label: 'Ship the thing', exists: true })
  })

  // The tombstone is D27's designed state, resolved by the same join the relations row
  // uses — a chip and a relation must never disagree about whether a task is gone.
  it('tombstones a task that is gone', () => {
    const chip = chipIn('first\nsee [[task:ghost]] ok', [known])
    expect(chip).toMatchObject({ label: '[deleted task]', exists: false })
  })

  // An explicit label is the author's words; the live title must not overwrite them.
  it('prefers an explicit |Label over the live title', () => {
    expect(chipIn('first\nsee [[task:t1|my words]] ok', [known])).toMatchObject({
      label: 'my words',
    })
  })

  // The unwired default must not invent a tombstone: a chip claiming "[deleted task]"
  // because a facet was missing would be a fresh lie of the kind this change removes.
  it('falls back to the raw id without claiming the task is gone', () => {
    expect(chipIn('first\nsee [[task:t1]] ok', [])).toMatchObject({ label: 't1', exists: true })
  })

  it('reveals the raw [[task:…]] when the caret is inside it', () => {
    // The caret starts on the line ABOVE: live preview reveals the whole line it touches,
    // so a caret on the chip's own line would make this pass for the wrong reason.
    const doc = 'first\nsee [[task:t1]] ok'
    expect(chipIn(doc, [known])).toBeDefined()
    const state = stateFor(doc, doc.indexOf('t1'), [known]) // caret inside the token
    expect(specs(buildDecorations(state, 0, doc.length)).some((d) => d.spec['widget'])).toBe(false)
  })

  // A note chip and a task chip route through different dataset keys, so a task id can
  // never be handed to the note-opening path as if it were a vault path.
  it('keeps note chips note-kind', () => {
    expect(chipIn('first\nsee [[notes/plan.md]] ok', [known])).toMatchObject({
      kind: 'note',
      target: 'notes/plan.md',
      label: 'notes/plan.md',
    })
  })

  // The label fallback used to live inside the widget and moved to the call site when
  // the widget grew a `kind`. Nothing covered it, so that move could have silently
  // broken every `[[path|Label]]` in the vault — found by mutation, pinned here.
  it('renders a note chip by its explicit |Label', () => {
    expect(chipIn('first\nsee [[notes/plan.md|The Plan]] ok', [known])).toMatchObject({
      kind: 'note',
      target: 'notes/plan.md',
      label: 'The Plan',
    })
  })
})
