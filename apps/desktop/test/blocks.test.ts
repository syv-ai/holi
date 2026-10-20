import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  blockAt,
  canMoveBlock,
  deleteBlock,
  duplicateBlock,
  insertBlockRow,
  moveBlock,
  moveBlockTo,
  turnInto,
  type Block,
} from '../src/renderer/src/editor/blocks'
import { alphaLists } from '../src/renderer/src/editor/lists'

function state(doc: string, at = 0): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(at),
    extensions: markdown({ base: markdownLanguage, extensions: [alphaLists] }),
  })
}

const apply = (s: EditorState, spec: TransactionSpec | null): string => {
  expect(spec).not.toBeNull()
  return s.update(spec!).state.doc.toString()
}

/** The block on the line holding `needle`. */
function at(s: EditorState, needle: string): Block {
  const b = blockAt(s, s.doc.toString().indexOf(needle))
  expect(b).not.toBeNull()
  return b!
}

describe('what a block is', () => {
  it('is the top-level node, or the innermost list item with its children', () => {
    const s = state('# Title\n\nA para\nwraps\n\n- one\n    - two\n- three\n')
    expect(at(s, 'Title')).toMatchObject({ kind: 'heading-1', listItem: false })
    const para = at(s, 'wraps')
    expect(s.sliceDoc(para.from, para.to)).toBe('A para\nwraps')
    const one = at(s, 'one')
    expect(s.sliceDoc(one.from, one.to)).toBe('- one\n    - two')
    expect(at(s, 'two')).toMatchObject({ listItem: true, indent: 4, kind: 'bullet-list' })
  })

  it('names lists, tasks, quotes, fences, rules, tables and the contents line', () => {
    const s = state(
      '1. n\n\n- [ ] t\n\n> q\n\n```js\nx\n```\n\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n[toc]\n',
    )
    expect(at(s, 'n').kind).toBe('numbered-list')
    expect(at(s, '[ ] t').kind).toBe('task-list')
    expect(at(s, 'q').kind).toBe('quote')
    expect(at(s, 'x\n').kind).toBe('code-block')
    expect(at(s, '---\n\n|').kind).toBe('divider')
    expect(at(s, '| 1').kind).toBe('table')
    expect(at(s, '[toc]').kind).toBe('contents')
  })

  it('is nothing on a blank line or in the frontmatter', () => {
    const s = state('---\ntitle: x\n---\n\npara\n')
    expect(blockAt(s, 4)).toBeNull()
    expect(blockAt(s, s.doc.toString().indexOf('\n\n') + 1)).toBeNull()
    expect(at(s, 'para').kind).toBe('text')
  })
})

describe('an aligned block', () => {
  const doc = 'one\n\n<div align="center">\n\nmid\n\n</div>\n\nthree'

  it('is its wrapper and the text inside, from any of its lines', () => {
    const s = state(doc)
    const open = doc.indexOf('<div')
    const close = doc.indexOf('</div>') + '</div>'.length
    for (const pos of [open, open + 21, doc.indexOf('mid'), close - 7, close - 1]) {
      expect(blockAt(s, pos)).toMatchObject({
        from: open,
        to: close,
        kind: 'text',
        align: 'center',
        content: { from: doc.indexOf('mid'), to: doc.indexOf('mid') + 3 },
      })
    }
  })

  it('moves, duplicates and deletes as one block', () => {
    const s = state(doc)
    expect(apply(s, moveBlock(s, at(s, 'mid'), -1))).toBe(
      '<div align="center">\n\nmid\n\n</div>\n\none\n\nthree',
    )
    expect(apply(s, moveBlock(s, at(s, 'three'), -1))).toBe(
      'one\n\nthree\n\n<div align="center">\n\nmid\n\n</div>',
    )
    expect(apply(s, duplicateBlock(s, at(s, 'mid')))).toBe(
      'one\n\n<div align="center">\n\nmid\n\n</div>\n\n<div align="center">\n\nmid\n\n</div>\n\nthree',
    )
    expect(apply(s, deleteBlock(s, at(s, '</div>')))).toBe('one\n\nthree')
  })

  it('turns into another kind inside its wrapper', () => {
    const s = state(doc)
    expect(apply(s, turnInto(s, at(s, 'mid'), 'heading-2'))).toBe(
      'one\n\n<div align="center">\n\n## mid\n\n</div>\n\nthree',
    )
  })
})

describe('moving a block among its siblings', () => {
  it('swaps top-level blocks and keeps the gap between them', () => {
    const s = state('one\n\ntwo\n\nthree')
    expect(apply(s, moveBlock(s, at(s, 'two'), -1))).toBe('two\n\none\n\nthree')
    expect(apply(s, moveBlock(s, at(s, 'two'), 1))).toBe('one\n\nthree\n\ntwo')
  })

  it('moves a list item with its children, inside its list only', () => {
    const s = state('- a\n    - a1\n- b\n')
    expect(apply(s, moveBlock(s, at(s, '- b'), -1))).toBe('- b\n- a\n    - a1\n')
    expect(canMoveBlock(s, at(s, 'a1'), -1)).toBe(false)
    expect(canMoveBlock(s, at(s, '- a'), -1)).toBe(false)
    expect(canMoveBlock(s, at(s, '- a'), 1)).toBe(true)
  })

  it('moves a fence whole', () => {
    const s = state('p\n\n```\na\n\nb\n```')
    expect(apply(s, moveBlock(s, at(s, '```'), -1))).toBe('```\na\n\nb\n```\n\np')
  })

  it('carries the caret with the block it is in', () => {
    const s = state('one\n\ntwo', 6)
    const next = s.update(moveBlock(s, at(s, 'two'), -1)!).state
    expect(next.selection.main.head).toBe(1)
  })

  it('is a list reshape, so ordered numbers are rewritten after it', () => {
    const s = state('1. a\n2. b\n')
    const spec = moveBlock(s, at(s, '2. b'), -1)!
    expect(spec.userEvent).toBe('move.line')
  })
})

describe('duplicate, delete and a new row', () => {
  it('duplicates below, with the right gap', () => {
    const s = state('one\n\n- a\n- b')
    expect(apply(s, duplicateBlock(s, at(s, 'one')))).toBe('one\n\none\n\n- a\n- b')
    expect(apply(s, duplicateBlock(s, at(s, '- a')))).toBe('one\n\n- a\n- a\n- b')
  })

  it('deletes without leaving a double gap', () => {
    const s = state('one\n\ntwo\n\nthree')
    expect(apply(s, deleteBlock(s, at(s, 'two')))).toBe('one\n\nthree')
    expect(apply(s, deleteBlock(s, at(s, 'three')))).toBe('one\n\ntwo')
    const l = state('- a\n- b\n- c')
    expect(apply(l, deleteBlock(l, at(l, '- b')))).toBe('- a\n- c')
  })

  it('opens an empty row below or above, an item where items are', () => {
    const s = state('one\n\n- a\n- [ ] b\n')
    expect(apply(s, insertBlockRow(s, at(s, 'one'), 'after'))).toBe('one\n\n\n\n- a\n- [ ] b\n')
    expect(apply(s, insertBlockRow(s, at(s, '- a'), 'after'))).toBe('one\n\n- a\n- \n- [ ] b\n')
    expect(apply(s, insertBlockRow(s, at(s, '- [ ] b'), 'before'))).toBe(
      'one\n\n- a\n- [ ] \n- [ ] b\n',
    )
  })

  it('reuses an empty item rather than adding a second', () => {
    const s = state('- a\n- ')
    const empty = blockAt(s, s.doc.length)!
    const spec = insertBlockRow(s, empty, 'after')
    expect(spec.changes).toBeUndefined()
    expect((spec.selection as { head: number }).head).toBe(s.doc.length)
  })
})

describe('dropping a block somewhere else', () => {
  it('moves a top-level block before another', () => {
    const s = state('one\n\ntwo\n\nthree')
    expect(apply(s, moveBlockTo(s, at(s, 'three'), at(s, 'one'), 'before'))).toBe(
      'three\n\none\n\ntwo',
    )
    expect(apply(s, moveBlockTo(s, at(s, 'one'), at(s, 'three'), 'after'))).toBe(
      'two\n\nthree\n\none',
    )
  })

  it('refuses a drop back where it is', () => {
    const s = state('one\n\ntwo')
    expect(moveBlockTo(s, at(s, 'one'), at(s, 'two'), 'before')).toBeNull()
    expect(moveBlockTo(s, at(s, 'one'), at(s, 'one'), 'after')).toBeNull()
  })

  it('an item joins another list at its depth and takes its marker', () => {
    const s = state('- a\n- b\n\n1. x\n    1. y\n')
    expect(apply(s, moveBlockTo(s, at(s, '- b'), at(s, 'y'), 'after'))).toBe(
      '- a\n\n1. x\n    1. y\n    1. b\n',
    )
  })

  it('a paragraph dropped on an item lands beside the whole list', () => {
    const s = state('p\n\n- a\n- b\n\nq')
    expect(apply(s, moveBlockTo(s, at(s, 'q'), at(s, '- b'), 'before'))).toBe('p\n\nq\n\n- a\n- b')
  })
})

describe('turn into', () => {
  const turn = (doc: string, needle: string, kind: Parameters<typeof turnInto>[2]) => {
    const s = state(doc)
    return apply(s, turnInto(s, at(s, needle), kind))
  }

  it('rewrites the prefix and keeps the text', () => {
    expect(turn('hello', 'hello', 'heading-2')).toBe('## hello')
    expect(turn('## hello', 'hello', 'text')).toBe('hello')
    expect(turn('## hello', 'hello', 'bullet-list')).toBe('- hello')
    expect(turn('- hello', 'hello', 'task-list')).toBe('- [ ] hello')
    expect(turn('- [x] hello', 'hello', 'numbered-list')).toBe('1. hello')
    expect(turn('1. hello', 'hello', 'quote')).toBe('> hello')
  })

  it('quotes and unquotes every line', () => {
    expect(turn('a\nb', 'a', 'quote')).toBe('> a\n> b')
    expect(turn('> a\n> b', 'a', 'text')).toBe('a\nb')
  })

  it('fences and unfences code', () => {
    expect(turn('a\nb', 'a', 'code-block')).toBe('```\na\nb\n```')
    expect(turn('```js\n# not a heading\n```', 'not', 'text')).toBe('# not a heading')
  })

  it('joins a heading onto one line, and drops a setext underline', () => {
    expect(turn('a\nb', 'a', 'heading-1')).toBe('# a b')
    expect(turn('Title\n===', 'Title', 'heading-3')).toBe('### Title')
  })

  it('turns only an item’s own text, not its sublist', () => {
    expect(turn('- a\n    - b', '- a', 'task-list')).toBe('- [ ] a\n    - b')
    expect(turn('- a\n    - b', 'b', 'numbered-list')).toBe('- a\n    1. b')
  })

  it('an empty heading becomes an empty item, ready to type in', () => {
    const s = state('# ')
    const next = s.update(turnInto(s, at(s, '# '), 'bullet-list')!).state
    expect(next.doc.toString()).toBe('- ')
  })
})
