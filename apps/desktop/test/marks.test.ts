import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { blockAt } from '../src/renderer/src/editor/blocks'
import { linkAt, normalizeHref, removeLink, setLink } from '../src/renderer/src/editor/formatting'
import {
  activeMarks,
  alignDecorations,
  alignOf,
  highlightAt,
  highlightSyntax,
  markSpans,
  setAlign,
  setHighlight,
  toggleUnderline,
} from '../src/renderer/src/editor/marks'

function state(doc: string, anchor = 0, head = anchor): EditorState {
  const s = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: markdown({ base: markdownLanguage, extensions: [highlightSyntax] }),
  })
  ensureSyntaxTree(s, s.doc.length, 1000)
  return s
}

/** The state with `needle` selected. */
function selecting(doc: string, needle: string): EditorState {
  const i = doc.indexOf(needle)
  return state(doc, i, i + needle.length)
}

const apply = (s: EditorState, spec: TransactionSpec | null) => {
  expect(spec).not.toBeNull()
  return s.update(spec!).state
}

describe('==highlight== is in the tree', () => {
  it('parses as a Highlight with its two marks', () => {
    const spans = markSpans(state('a ==b c== d'))
    expect(spans).toEqual([
      { kind: 'highlight', from: 2, to: 9, innerFrom: 4, innerTo: 7, color: 'yellow' },
    ])
  })

  it('does not take `===` or a lone `==`', () => {
    expect(markSpans(state('a === b'))).toEqual([])
    expect(markSpans(state('x == y'))).toEqual([])
  })

  it('pairs <mark data-color> and <u> within their paragraph', () => {
    const spans = markSpans(state('<mark data-color="green">g</mark> and <u>u</u>'))
    expect(spans.map((s) => [s.kind, s.color ?? null])).toEqual([
      ['highlight', 'green'],
      ['underline', null],
    ])
  })
})

describe('highlight', () => {
  it('yellow writes ==, every other colour a <mark>', () => {
    expect(
      apply(
        selecting('a word', 'word'),
        setHighlight(selecting('a word', 'word'), 'yellow'),
      ).doc.toString(),
    ).toBe('a ==word==')
    const s = selecting('a word', 'word')
    expect(apply(s, setHighlight(s, 'pink')).doc.toString()).toBe(
      'a <mark data-color="pink">word</mark>',
    )
  })

  it('recolours and removes the highlight the selection is in, text kept selected', () => {
    const s = selecting('a ==word==', 'word')
    expect(highlightAt(s)).toBe('yellow')
    const blue = apply(s, setHighlight(s, 'blue'))
    expect(blue.doc.toString()).toBe('a <mark data-color="blue">word</mark>')
    expect(blue.sliceDoc(blue.selection.main.from, blue.selection.main.to)).toBe('word')
    const off = apply(blue, setHighlight(blue, null))
    expect(off.doc.toString()).toBe('a word')
  })

  it('has nothing to remove where there is no highlight', () => {
    expect(setHighlight(selecting('a word', 'word'), null)).toBeNull()
  })
})

describe('underline', () => {
  it('wraps in <u> and unwraps again', () => {
    const s = selecting('a word', 'word')
    const on = apply(s, toggleUnderline(s))
    expect(on.doc.toString()).toBe('a <u>word</u>')
    const off = apply(on, toggleUnderline(on))
    expect(off.doc.toString()).toBe('a word')
  })
})

describe('which marks hold the selection', () => {
  it('reads bold, code, underline, highlight and link', () => {
    expect(activeMarks(selecting('**bold**', 'bold')).bold).toBe(true)
    expect(activeMarks(selecting('`c`', 'c')).code).toBe(true)
    expect(activeMarks(selecting('<u>x</u>', 'x')).underline).toBe(true)
    expect(activeMarks(selecting('==x==', 'x')).highlight).toBe('yellow')
    expect(activeMarks(selecting('[t](https://a.io)', 't')).link).toBe(true)
    expect(activeMarks(selecting('plain', 'plain'))).toMatchObject({ bold: false, link: false })
  })
})

describe('alignment', () => {
  it('wraps a paragraph in <div align> with blank lines, so it stays markdown', () => {
    const s = state('one **bold**\n')
    const b = blockAt(s, 0)!
    const centred = apply(s, setAlign(s, b, 'center'))
    expect(centred.doc.toString()).toBe('<div align="center">\n\none **bold**\n\n</div>\n')
    const again = blockAt(centred, centred.doc.toString().indexOf('one'))!
    expect(alignOf(centred, again)).toBe('center')
  })

  it('changes the wrapper, and left takes it away', () => {
    const s = state('<div align="center">\n\nhi\n\n</div>')
    const b = blockAt(s, s.doc.toString().indexOf('hi'))!
    expect(apply(s, setAlign(s, b, 'right')).doc.toString()).toBe(
      '<div align="right">\n\nhi\n\n</div>',
    )
    expect(apply(s, setAlign(s, b, 'left')).doc.toString()).toBe('hi')
  })

  it('refuses a list item, where a wrapper would end the list', () => {
    const s = state('- a\n- b')
    expect(setAlign(s, blockAt(s, 0)!, 'center')).toBeNull()
  })

  /** The wrapper's decorations: a fold's range, or a line's class. */
  const painted = (s: EditorState): string[] => {
    const out: string[] = []
    alignDecorations(s).between(0, s.doc.length, (from, to, d) => {
      out.push(d.spec.block === true ? `fold ${s.sliceDoc(from, to)}` : String(d.spec.class))
    })
    return out
  }

  it('folds the tags away off the caret and paints the text inside', () => {
    const doc = 'above\n\n<div align="center">\n\nhi\n\n</div>\n\nbelow'
    expect(painted(state(doc))).toEqual([
      'fold <div align="center">\n',
      'cm-align cm-align-center',
      'fold \n</div>',
    ])
    expect(painted(state(doc, doc.indexOf('below')))).toHaveLength(3)
  })

  it('shows the tags, small, with the caret anywhere in the wrapper', () => {
    const doc = '<div align="center">\n\nhi\n\n</div>'
    for (const at of [0, doc.indexOf('hi') + 1, doc.length]) {
      expect(painted(state(doc, at))).toEqual([
        'cm-align-tag',
        'cm-align-gap',
        'cm-align cm-align-center',
        'cm-align-gap',
        'cm-align-tag',
      ])
    }
  })

  it('never folds a wrapper written without its blank lines', () => {
    const s = state('x\n\n<div align="right">\nhi\n</div>')
    expect(painted(s)).toEqual(['cm-align-tag', 'cm-align cm-align-right', 'cm-align-tag'])
  })
})

describe('links, as the link field edits them', () => {
  it('normalizes a typed address, or refuses it', () => {
    expect(normalizeHref('example.com')).toBe('https://example.com')
    expect(normalizeHref(' https://a.io/x ')).toBe('https://a.io/x')
    expect(normalizeHref('mailto:a@b.co')).toBe('mailto:a@b.co')
    expect(normalizeHref('not a link')).toBeNull()
  })

  it('finds the link around a position, not an image', () => {
    const s = state('see [the docs](https://a.io) and ![i](x.png)')
    const link = linkAt(s, 6)!
    expect(link.url).toBe('https://a.io')
    expect(s.sliceDoc(link.textFrom, link.textTo)).toBe('the docs')
    expect(linkAt(s, s.doc.toString().indexOf('x.png'))).toBeNull()
  })

  it('links a selection, re-addresses a link, and writes a bare address as its own link', () => {
    const sel = selecting('read this', 'this')
    expect(apply(sel, setLink(sel, 'https://a.io')).doc.toString()).toBe(
      'read [this](https://a.io)',
    )
    const inLink = selecting('[t](https://old.io)', 't')
    expect(apply(inLink, setLink(inLink, 'https://new.io')).doc.toString()).toBe(
      '[t](https://new.io)',
    )
    const caret = state('x ', 2)
    expect(apply(caret, setLink(caret, 'https://a.io', 'a.io')).doc.toString()).toBe(
      'x [a.io](https://a.io)',
    )
  })

  it('removes a link and keeps its text', () => {
    const s = selecting('[keep](https://a.io)', 'keep')
    expect(apply(s, removeLink(s)).doc.toString()).toBe('keep')
  })
})
