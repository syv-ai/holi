import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { slashCommands } from '../src/renderer/src/editor/slash'

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

  it('/table inserts a valid markdown table skeleton (header + delimiter + row)', () => {
    const apply = slashCommands(ctx('/'))!.options.find((o) => o.label === '/table')!
      .apply as string
    const lines = apply.split('\n')
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
