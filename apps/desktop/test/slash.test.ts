import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  slashCommands,
  tableSizes,
  TABLE_SIZES,
  buildTable,
} from '../src/renderer/src/editor/slash'

function ctx(doc: string, pos = doc.length, explicit = false) {
  return new CompletionContext(EditorState.create({ doc }), pos, explicit)
}

describe('slashCommands (FR-9)', () => {
  it('offers commands anchored at the / when it starts a line', () => {
    const result = slashCommands(ctx('/'))
    expect(result).not.toBeNull()
    expect(result!.from).toBe(0)
    const labels = result!.options.map((o) => o.label)
    expect(labels).toContain('/todo')
    expect(labels).toContain('/table')
  })

  it('/todo inserts a checkbox line', () => {
    const opt = slashCommands(ctx('/'))!.options.find((o) => o.label === '/todo')
    expect(opt!.apply).toBe('- [ ] ')
  })

  // It inserts a plain markdown checkbox and nothing else. It was called /subtask, which
  // promised a parent task that cannot exist: this editor only ever opens notes (a task's
  // description is a plain textarea, not CodeMirror).
  it('offers no /subtask — a note has no parent task', () => {
    const labels = slashCommands(ctx('/'))!.options.map((o) => o.label)
    expect(labels).not.toContain('/subtask')
  })

  // `/table` no longer inserts anything directly — it opens the sizes, and the
  // skeleton moved to `buildTable`. The shape it produces is still the contract.
  it('the default size is a valid markdown table skeleton (header + delimiter + row)', () => {
    const lines = buildTable(TABLE_SIZES[0]!).split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(lines[1]).toMatch(/^\|\s*-+\s*\|/) // the --- delimiter row
  })

  it('does not trigger on a / inside a path or url (preceded by a non-space)', () => {
    expect(slashCommands(ctx('see foo/bar'))).toBeNull()
    expect(slashCommands(ctx('http://'))).toBeNull()
  })

  it('triggers after whitespace, not only at the very start of the line', () => {
    expect(slashCommands(ctx('- /'))).not.toBeNull()
  })

  it('filters commands by the query after the / (custom filter, / excluded)', () => {
    const result = slashCommands(ctx('/tod'))
    const labels = result!.options.map((o) => o.label)
    expect(labels).toEqual(['/todo'])
    expect(result!.filter).toBe(false)
  })
})

describe('/table asks what size, instead of guessing', () => {
  it('picking /table does not insert a table, it opens the sizes', () => {
    const opt = slashCommands(ctx('/'))!.options.find((o) => o.label === '/table')!
    // An `apply` function, not a string: it types the argument and re-opens.
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

  it('backspacing out of the argument returns to the command list', () => {
    // No back-navigation code: `/table` matches the first level again.
    expect(slashCommands(ctx('/table'))!.options.map((o) => o.label)).toContain('/table')
  })
})

describe('the command trigger is not ASCII-only', () => {
  // Same `\w` bug as `@`: a non-ASCII letter after the `/` returned null and
  // closed the popup rather than simply matching nothing.
  it('a non-ASCII letter filters to nothing without dismissing the menu', () => {
    const result = slashCommands(ctx('/æ'))
    expect(result).not.toBeNull()
    expect(result!.options).toEqual([])
  })
})
