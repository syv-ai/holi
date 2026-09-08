import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  buildDecorations,
  revealedSpans,
  spanKey,
  taskByPathFacet,
  touches,
} from '../src/renderer/src/editor/livePreview'
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

describe('buildDecorations', () => {
  // A heading's `#` is the one mark that is never replaced: it stays in the DOM
  // as `.cm-heading-mark` so its box can be transitioned, and whether it is open
  // is the LINE's `cm-heading-raw`. Both are asserted here because the pair is
  // the contract the slide depends on.
  const headingLineClass = (doc: string, caret: number) => {
    const state = stateFor(doc, caret)
    const line = specs(buildDecorations(state, 0, state.doc.length)).find(
      (d) => d.from === 0 && d.to === 0,
    )
    return String(line?.spec['class'] ?? '')
  }

  it('marks the heading mark rather than replacing it, always', () => {
    for (const caret of [12, 3]) {
      const state = stateFor('# Title\n\nbody text', caret)
      const mark = specs(buildDecorations(state, 0, state.doc.length)).find(
        (d) => d.from === 0 && d.to === 2,
      )
      expect(mark?.spec['class']).toBe('cm-heading-mark')
      expect(mark?.spec['widget']).toBeUndefined()
    }
  })

  it('leaves the heading mark closed on an inactive line', () => {
    expect(headingLineClass('# Title\n\nbody text', 12)).not.toContain('cm-heading-raw')
  })

  it('opens the heading mark on the active line', () => {
    expect(headingLineClass('# Title\n\nbody text', 3)).toContain('cm-heading-raw')
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
    // The caret starts on the line ABOVE the chip so that the chip's own line is
    // not what puts it raw. Since D91 only the element itself would do that
    // anyway, but the doc is left as it was: it costs nothing and covers both.
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

  /** The glyph drawn for the marker starting `text`, or undefined. The caret
   *  sits at 0, so every list line below the opening paragraph is inactive. */
  function glyphIn(doc: string, text: string): string | undefined {
    const at = doc.indexOf(text)
    const found = decos(doc).all.find((d) => d.from === at && d.to === at + 1)
    return (found?.spec['widget'] as { glyph?: string } | undefined)?.glyph
  }

  it('draws -, * and + as one bullet', () => {
    for (const marker of ['-', '*', '+']) {
      expect(glyphIn(`para\n\n${marker} item`, `${marker} item`)).toBe('•')
    }
  })

  it('deepens the bullet the way a nested list looks everywhere else', () => {
    const doc = 'para\n\n- one\n  - two\n    - three\n      - four'
    expect(glyphIn(doc, '- one')).toBe('•')
    expect(glyphIn(doc, '- two')).toBe('◦')
    expect(glyphIn(doc, '- three')).toBe('▪')
    // Deeper than the ladder goes keeps the last rung rather than falling off it.
    expect(glyphIn(doc, '- four')).toBe('▪')
  })

  it('indents a., A. and a), which markdown has no list for', () => {
    for (const marker of ['a.', 'A.', 'a)', 'Z)']) {
      expect(depthOf(`para\n\n${marker} item`, `${marker} item`)).toBe('--list-depth:1')
    }
  })

  it('nests an alphabetic list under the numbered one it sits in', () => {
    const doc = '1. one\n   a. sub\n   b. other'
    expect(depthOf(doc, 'a. sub')).toBe('--list-depth:2')
    expect(depthOf(doc, 'b. other')).toBe('--list-depth:2')
  })

  it('keeps indenting past the first item, which no blank line precedes', () => {
    const doc = 'para\n\na. first\nb. second\nc. third'
    expect(depthOf(doc, 'b. second')).toBe('--list-depth:1')
    expect(depthOf(doc, 'c. third')).toBe('--list-depth:1')
  })

  // The cost of a marker the parser does not know is that this file has to
  // decide for itself, so it decides conservatively — and about the run, not
  // the line, or the second sentence here would become a list on its own.
  it('leaves a sentence that opens like one alone', () => {
    const doc = 'Someone wrote it.\nA. Smith said so\nB. Jones agreed'
    expect(depthOf(doc, 'A. Smith')).toBeUndefined()
    expect(depthOf(doc, 'B. Jones')).toBeUndefined()
  })

  it('leaves a fenced block alone', () => {
    const doc = 'para\n\n```\n\na) not a list\n```'
    expect(depthOf(doc, 'a) not')).toBeUndefined()
  })

  it('draws a task marker as a checkbox, and its bullet not at all', () => {
    const doc = 'para\n\n- [ ] feed the cat'
    const { all } = decos(doc)
    const dash = doc.indexOf('- [ ]')
    // The `- ` goes, space included, so the box sits where a bullet would.
    expect(all.some((d) => d.from === dash && d.to === dash + 2)).toBe(true)
    const box = all.find((d) => d.from === dash + 2 && d.to === dash + 5)
    expect((box?.spec['widget'] as { checked?: boolean } | undefined)?.checked).toBe(false)
  })

  it('reads [x] and [X] as done', () => {
    for (const marker of ['[x]', '[X]']) {
      const doc = `para\n\n- ${marker} done`
      const at = doc.indexOf(marker)
      const box = decos(doc).all.find((d) => d.from === at && d.to === at + 3)
      expect((box?.spec['widget'] as { checked?: boolean } | undefined)?.checked).toBe(true)
    }
  })

  // A control the caret can chase away is a control you cannot click from the
  // line it is on.
  it('keeps the checkbox with the caret on its line', () => {
    const doc = '- [ ] feed the cat'
    const box = decos(doc, 8).all.find((d) => d.from === 2 && d.to === 5)
    expect(box?.spec['widget']).toBeDefined()
  })

  it('leaves an ordered marker as its number', () => {
    const { all } = decos('1. one')
    const marker = all.find((d) => d.from === 0 && d.to === 2)
    expect(marker?.spec['widget']).toBeUndefined()
    expect(marker?.spec['class']).toBe('cm-list-mark')
  })

  // Same contract as every other mark in the file, and the two states wear the
  // same box, so the line does not move (FR-3b).
  it('shows the raw marker on the line the caret is on', () => {
    const { all } = decos('- item', 3)
    const marker = all.find((d) => d.from === 0 && d.to === 1)
    expect(marker?.spec['widget']).toBeUndefined()
    expect(marker?.spec['class']).toContain('cm-list-bullet')
  })

  it('holds the text off the marker', () => {
    const { all } = decos('1. top')
    const mark = all.find((d) => d.spec['class'] === 'cm-list-mark')
    expect(mark).toEqual(expect.objectContaining({ from: 0, to: 2 }))
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

describe('revealedSpans (D91: the element, not the line)', () => {
  const at = (pos: number) => ({ from: pos, to: pos })

  it('counts a caret resting on either edge as being on the element', () => {
    const bold = { from: 4, to: 12 }
    expect(touches(at(4), bold)).toBe(true)
    expect(touches(at(12), bold)).toBe(true)
    expect(touches(at(3), bold)).toBe(false)
    expect(touches(at(13), bold)).toBe(false)
  })

  it('reveals only the innermost of two nested elements', () => {
    const outer = { from: 0, to: 30 }
    const inner = { from: 10, to: 20 }
    expect(revealedSpans([outer, inner], at(15))).toEqual(new Set([spanKey(inner)]))
  })

  it('reveals the outer element when the caret is on its own text', () => {
    const outer = { from: 0, to: 30 }
    const inner = { from: 10, to: 20 }
    expect(revealedSpans([outer, inner], at(5))).toEqual(new Set([spanKey(outer)]))
  })

  it('keeps both when two elements share a range — containment is strict', () => {
    const a = { from: 0, to: 10 }
    const b = { from: 0, to: 10 }
    expect(revealedSpans([a, b], at(5)).size).toBe(1)
  })

  it('reveals every innermost element a selection crosses', () => {
    const one = { from: 0, to: 5 }
    const two = { from: 10, to: 15 }
    expect(revealedSpans([one, two], { from: 2, to: 12 })).toEqual(
      new Set([spanKey(one), spanKey(two)]),
    )
  })
})

describe('buildDecorations — per-element reveal (D91)', () => {
  const concealedAt = (doc: string, caret: number, at: number, to: number) => {
    const state = stateFor(doc, caret)
    return specs(buildDecorations(state, 0, doc.length)).some((d) => d.from === at && d.to === to)
  }

  it('leaves the rest of the line rendered when the caret is in one element', () => {
    const doc = 'some **bold** and [[notes/plan.md]] here'
    const state = stateFor(doc, doc.indexOf('bold'))
    const decos = specs(buildDecorations(state, 0, doc.length))
    const bold = doc.indexOf('**')
    // the bold you are in shows its source...
    expect(decos.some((d) => d.from === bold && d.to === bold + 2)).toBe(false)
    // ...and the chip on the same line stays a chip, which D22 could not do
    const start = doc.indexOf('[[')
    expect(
      decos.some((d) => d.from === start && (d.spec['widget'] as unknown) !== undefined),
    ).toBe(true)
  })

  it('keeps the marks up while the caret rests on the closing edge', () => {
    const doc = 'some **bold** here'
    const bold = doc.indexOf('**')
    expect(concealedAt(doc, bold + 8, bold, bold + 2)).toBe(false)
    // one step further out and it renders again
    expect(concealedAt(doc, bold + 9, bold, bold + 2)).toBe(true)
  })

  it('reveals the inner element only, leaving the ** it sits in hidden', () => {
    const doc = 'x **bold with [[notes/plan.md]] inside** y'
    const state = stateFor(doc, doc.indexOf('plan'))
    const decos = specs(buildDecorations(state, 0, doc.length))
    const bold = doc.indexOf('**')
    expect(decos.some((d) => d.from === bold && d.to === bold + 2)).toBe(true)
    const start = doc.indexOf('[[')
    expect(
      decos.some((d) => d.from === start && (d.spec['widget'] as unknown) !== undefined),
    ).toBe(false)
  })

  const headingIsRaw = (doc: string, caret: number) => {
    const state = stateFor(doc, caret)
    const line = specs(buildDecorations(state, 0, doc.length)).find((d) => d.from === 0 && d.to === 0)
    return String(line?.spec['class'] ?? '').includes('cm-heading-raw')
  }

  it("opens a heading's # from anywhere on the heading, not just the marker", () => {
    expect(headingIsRaw('# Title\n\nbody', 6)).toBe(true)
  })

  it('leaves the # closed while the caret is on an element inside the heading', () => {
    const doc = '# Title **bold** end'
    expect(headingIsRaw(doc, doc.indexOf('bold'))).toBe(false)
  })
})
