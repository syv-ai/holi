import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
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

describe('buildDecorations — list indentation', () => {
  /** GFM, as production uses (`extensions.ts`): task items need it. */
  function gfm(doc: string, cursor = 0) {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(cursor),
      extensions: [markdown({ base: markdownLanguage })],
    })
    ensureSyntaxTree(state, state.doc.length, 5_000)
    return state
  }

  function decos(doc: string, cursor = 0) {
    const state = gfm(doc, cursor)
    return { state, all: specs(buildDecorations(state, 0, state.doc.length)) }
  }

  /** The depth stamped on the line that `text` starts, or undefined. */
  function depthOf(doc: string, text: string, cursor = 0): string | undefined {
    const { state, all } = decos(doc, cursor)
    const line = state.doc.lineAt(doc.indexOf(text))
    const found = all.find((d) => d.from === line.from && d.spec['class'] === 'cm-list')
    return (found?.spec['attributes'] as { style?: string } | undefined)?.style
  }

  it('indents a top-level bullet, which the raw source does not', () => {
    expect(depthOf('para\n\n- top', '- top')).toBe('--list-depth:1')
  })

  it('takes the depth from the tree, so two spaces nest as deep as four', () => {
    expect(depthOf('- top\n  - child', '- child')).toBe('--list-depth:2')
    expect(depthOf('- top\n    - child', '- child')).toBe('--list-depth:2')
  })

  it('goes deeper again on a third level', () => {
    expect(depthOf('- one\n  - two\n    - three', '- three')).toBe('--list-depth:3')
  })

  // The indent is arithmetic on the depth alone, so the author's own spaces have
  // to stop taking up room, or a four-space list would still sit further in.
  it('conceals the spaces the author typed before the marker', () => {
    const doc = '- top\n  - child'
    const { all } = decos(doc)
    const markAt = doc.indexOf('- child')
    expect(all.some((d) => d.from === markAt - 2 && d.to === markAt)).toBe(true)
  })

  // FR-3b: a conditional conceal would move the line when the caret arrived.
  it('conceals them with the caret on the line too', () => {
    const doc = '- top\n  - child'
    const markAt = doc.indexOf('- child')
    const { all } = decos(doc, doc.indexOf('child'))
    expect(all.some((d) => d.from === markAt - 2 && d.to === markAt)).toBe(true)
  })

  // A list inside a blockquote has `> ` in front of the marker, and the quote
  // mark is styled, not hidden.
  it('conceals whitespace only, never a quote mark', () => {
    const doc = '> - quoted'
    const { all } = decos(doc)
    const markAt = doc.indexOf('- quoted')
    // The quote mark keeps its own styling, and nothing swallows it.
    expect(all.some((d) => d.from === 0 && d.spec['class'] === 'cm-quote-mark')).toBe(true)
    expect(all.some((d) => d.from === 0 && d.to === markAt)).toBe(false)
    expect(all.some((d) => d.from === markAt - 1 && d.to === markAt)).toBe(true)
  })

  // The parser calls a bare `-` a list item with nothing in it, so without this
  // the line jumps 2em to the right the instant the marker is typed.
  it('waits for the space that makes a marker a list', () => {
    expect(depthOf('-', '-')).toBeUndefined()
    expect(depthOf('*', '*')).toBeUndefined()
    expect(depthOf('1.', '1.')).toBeUndefined()
    expect(depthOf('- ', '- ')).toBe('--list-depth:1')
  })

  it('holds the text off the marker', () => {
    const { all } = decos('- top')
    const mark = all.find((d) => d.spec['class'] === 'cm-list-mark')
    expect(mark).toEqual(expect.objectContaining({ from: 0, to: 1 }))
  })

  it('indents every marker markdown has: -, * and 1.', () => {
    expect(depthOf('- dash', '- dash')).toBe('--list-depth:1')
    expect(depthOf('* star', '* star')).toBe('--list-depth:1')
    expect(depthOf('1. one', '1. one')).toBe('--list-depth:1')
    expect(depthOf('* star\n  * nested', '* nested')).toBe('--list-depth:2')
  })

  it('indents an ordered list on the same ladder as a bulleted one', () => {
    expect(depthOf('1. one\n   1. nested', '1. nested')).toBe('--list-depth:2')
    // A two-digit marker is no different: the depth is the tree's, not the
    // marker's width.
    expect(depthOf('9. nine\n10. ten', '10. ten')).toBe('--list-depth:1')
  })

  it('leaves a task line a list line, chips and all', () => {
    expect(depthOf('- [ ] feed the cat', '- [ ]')).toBe('--list-depth:1')
  })

  // A ListItem spans its children; padding those lines too would double the
  // indent the source already carries.
  it('decorates the marker line only, not the rest of the item', () => {
    expect(depthOf('- a long bullet\n  lazy continuation', 'lazy continuation')).toBeUndefined()
  })
})
