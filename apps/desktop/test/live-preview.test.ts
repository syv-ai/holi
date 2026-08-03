import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { buildDecorations, taskByPathFacet } from '../src/renderer/src/editor/livePreview'
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
 * Task chips. A task is a file, so a link to a task is an ordinary path wiki-link
 * `[[…/task.foo.md]]` (D27/D60). The editor renders it as a task chip — carrying the
 * task's status for the orb — when the path resolves to a task via the store, and as a
 * plain note chip otherwise.
 */
describe('buildDecorations — task-path chips', () => {
  const TASK = 'projects/task.ship.md'
  const known = taskByPathFacet.of((path) =>
    path === TASK ? { title: 'Ship the thing', status: 'todo' } : null,
  )

  const chipIn = (doc: string, extra: Extension[]): WikiLinkChip | undefined => {
    const state = stateFor(doc, 0, extra)
    const found = specs(buildDecorations(state, 0, doc.length)).find((d) => d.spec['widget'])
    return found?.spec['widget'] as WikiLinkChip | undefined
  }

  it('renders a task chip titled by the resolver, carrying its status', () => {
    const chip = chipIn(`first\nsee [[${TASK}]] ok`, [known])
    expect(chip).toMatchObject({
      target: TASK,
      label: 'Ship the thing',
      exists: true,
      task: { status: 'todo' },
    })
  })

  // A path the store does not know is an ordinary note chip — never a task, never a lie.
  it('renders a note chip for a non-task path', () => {
    const chip = chipIn('first\nsee [[notes/plan.md]] ok', [known])
    expect(chip).toMatchObject({ target: 'notes/plan.md', label: 'notes/plan.md' })
    expect(chip?.task).toBeUndefined()
  })

  // An explicit label is the author's words; the live title must not overwrite them.
  it('prefers an explicit |Label over the live title', () => {
    expect(chipIn(`first\nsee [[${TASK}|my words]] ok`, [known])).toMatchObject({
      label: 'my words',
    })
  })

  // The unwired default resolves nothing as a task, so a task path with no store is a
  // plain note chip — no invented tombstone.
  it('with no store, a task path is just a note chip', () => {
    const chip = chipIn(`first\nsee [[${TASK}]] ok`, [])
    expect(chip).toMatchObject({ target: TASK, label: TASK })
    expect(chip?.task).toBeUndefined()
  })

  it('reveals the raw [[…]] when the caret is inside it', () => {
    // The caret starts on the line ABOVE: live preview reveals the whole line it touches,
    // so a caret on the chip's own line would make this pass for the wrong reason.
    const doc = `first\nsee [[${TASK}]] ok`
    expect(chipIn(doc, [known])).toBeDefined()
    const state = stateFor(doc, doc.indexOf('ship'), [known]) // caret inside the token
    expect(specs(buildDecorations(state, 0, doc.length)).some((d) => d.spec['widget'])).toBe(false)
  })

  // The label fallback lives at the call site; nothing else covers it, so a broken move
  // would silently break every `[[path|Label]]` in the vault.
  it('renders a note chip by its explicit |Label', () => {
    expect(chipIn('first\nsee [[notes/plan.md|The Plan]] ok', [known])).toMatchObject({
      target: 'notes/plan.md',
      label: 'The Plan',
    })
  })
})
