import { CompletionContext } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  applySlash,
  slashCommands,
  tableSizes,
  TABLE_SIZES,
  buildTable,
  SLASH_ITEMS,
  type SlashKind,
} from '../src/renderer/src/editor/slash'

const lang = markdown({ base: markdownLanguage })

function ctx(doc: string, pos = doc.length, explicit = false) {
  return new CompletionContext(EditorState.create({ doc, extensions: lang }), pos, explicit)
}

const labels = (doc: string) => slashCommands(ctx(doc))!.options.map((o) => o.label)

describe('the slash menu is ReUI’s', () => {
  it('lists every block, in two groups, in ReUI’s order', () => {
    const result = slashCommands(ctx('/'))!
    expect(result.from).toBe(0)
    expect(result.options.map((o) => o.label)).toEqual([
      'Text',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Bullet list',
      'Numbered list',
      'To-do list',
      'Quote',
      'Code block',
      'Divider',
      'Table',
      'Contents',
    ])
    const groups = result.options.map((o) =>
      typeof o.section === 'string' ? o.section : o.section?.name,
    )
    expect(new Set(groups)).toEqual(new Set(['Basic blocks', 'Advanced']))
    expect(groups.at(-1)).toBe('Advanced')
  })

  it('every row has a hint and a glyph, and the markdown shortcut where there is one', () => {
    const result = slashCommands(ctx('/'))!
    for (const o of result.options) {
      expect(o.detail).toBeTruthy()
      expect(o.type).toMatch(/^holi-block-/)
    }
    const h1 = result.options.find((o) => o.label === 'Heading 1') as { meta?: string }
    expect(h1.meta).toBe('#')
  })

  it('matches a title anywhere and a keyword from its start', () => {
    // "headings" is one of Contents' words.
    expect(labels('/head')).toEqual(['Heading 1', 'Heading 2', 'Heading 3', 'Contents'])
    expect(labels('/ul')).toEqual(['Bullet list'])
    expect(labels('/toc')).toEqual(['Contents'])
    expect(labels('/st')).toContain('Numbered list') // "steps"
  })

  it('still answers /todo and /table', () => {
    expect(labels('/todo')).toEqual(['To-do list'])
    expect(labels('/table')).toEqual(['Table'])
  })

  it('says when nothing matches, and Enter there is a plain Enter', () => {
    const result = slashCommands(ctx('/zzz'))!
    expect(result.options).toHaveLength(1)
    expect(result.options[0]!.label).toBe('No matching blocks')
    expect(typeof result.options[0]!.apply).toBe('function')
  })

  it('does not open in code or in the frontmatter', () => {
    expect(slashCommands(ctx('```\n/'))).toBeNull()
    expect(slashCommands(ctx('---\ntitle: /\n---\n', 12))).toBeNull()
  })

  it('does not trigger on a / inside a path or url (preceded by a non-space)', () => {
    expect(slashCommands(ctx('see foo/bar'))).toBeNull()
    expect(slashCommands(ctx('http://'))).toBeNull()
  })

  it('triggers after whitespace, not only at the very start of the line', () => {
    expect(slashCommands(ctx('- /'))).not.toBeNull()
  })

  it('filters itself, with the / excluded', () => {
    expect(slashCommands(ctx('/tod'))!.filter).toBe(false)
  })
})

describe('what an item makes', () => {
  const run = (doc: string, kind: SlashKind) => {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: lang,
    })
    const from = doc.lastIndexOf('/')
    const next = state.update(applySlash(state, from, doc.length, kind)).state
    return { doc: next.doc.toString(), caret: next.selection.main.head }
  }

  it('makes a fresh block on an empty line, caret ready to type', () => {
    expect(run('/h1', 'heading-1')).toEqual({ doc: '# ', caret: 2 })
    expect(run('/todo', 'task-list')).toEqual({ doc: '- [ ] ', caret: 6 })
    expect(run('/ul', 'bullet-list').doc).toBe('- ')
    expect(run('/ol', 'numbered-list').doc).toBe('1. ')
    expect(run('/quote', 'quote').doc).toBe('> ')
  })

  it('opens a fence with the caret inside it', () => {
    expect(run('/code', 'code-block')).toEqual({ doc: '```\n\n```', caret: 4 })
  })

  it('turns the line it was typed on, keeping its text', () => {
    expect(run('Plan /h2', 'heading-2').doc).toBe('## Plan ')
    expect(run('## Plan /text', 'text').doc).toBe('Plan ')
  })

  it('puts a divider on a line of its own, never under text (a setext heading)', () => {
    expect(run('Text\n/div', 'divider')).toEqual({ doc: 'Text\n\n---\n', caret: 10 })
    expect(run('Text /div', 'divider').doc).toBe('Text \n\n---\n\n')
  })

  it('writes Contents as a [toc] line', () => {
    expect(run('/toc', 'contents').doc).toBe('[toc]\n')
  })

  it('is one undo step: the typed query and the block in one transaction', () => {
    const state = EditorState.create({ doc: '/h1', extensions: lang })
    const spec = applySlash(state, 0, 3, 'heading-1')
    expect(spec.userEvent).toBe('input.complete')
  })

  it('names an id for every item', () => {
    expect(new Set(SLASH_ITEMS.map((i) => i.id)).size).toBe(SLASH_ITEMS.length)
  })
})

describe('/table asks what size, instead of guessing', () => {
  it('picking Table does not insert a table, it opens the sizes', () => {
    const opt = slashCommands(ctx('/'))!.options.find((o) => o.label === 'Table')!
    // An `apply` function that types the argument and re-opens.
    expect(typeof opt.apply).toBe('function')
  })

  it('the sizes source only fires once the command has an argument slot', () => {
    expect(tableSizes(ctx('/table'))).toBeNull()
    expect(tableSizes(ctx('/table '))).not.toBeNull()
  })

  it('the sizes replace the whole command, not just the argument', () => {
    // `from` at the `/`, so picking a size leaves no `/table ` behind.
    expect(tableSizes(ctx('/table '))!.from).toBe(0)
  })

  it('every size is a valid GFM table: header, delimiter, then body rows', () => {
    for (const size of TABLE_SIZES) {
      const lines = buildTable(size).split('\n')
      expect(lines).toHaveLength(2 + size.rows)
      expect(lines[1]).toMatch(/^\|(\s*-+\s*\|)+$/)
      expect(lines[0]!.split('|').length - 2).toBe(size.cols)
    }
  })

  it("today's table is the first size offered, so Enter Enter is the old behaviour", () => {
    expect(TABLE_SIZES[0]).toEqual({ cols: 2, rows: 1 })
  })

  it('the sizes carry a trail header saying where you are', () => {
    const section = tableSizes(ctx('/table '))!.options[0]!.section
    expect(typeof section === 'string' ? section : section?.name).toBe('table')
  })

  it('backspacing out of the argument returns to the block list', () => {
    expect(labels('/table')).toContain('Table')
  })
})

describe('the command trigger is not ASCII-only', () => {
  // Same `\w` bug as `@`: a non-ASCII letter after the `/` returned null and
  // closed the popup rather than simply matching nothing.
  it('a non-ASCII letter matches nothing without dismissing the menu', () => {
    const result = slashCommands(ctx('/æ'))
    expect(result).not.toBeNull()
    expect(result!.options.map((o) => o.label)).toEqual(['No matching blocks'])
  })
})
