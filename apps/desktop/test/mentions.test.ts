import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { mentionCompletions } from '../src/renderer/src/editor/mentions'

function ctx(doc: string, pos = doc.length, explicit = false) {
  return new CompletionContext(EditorState.create({ doc }), pos, explicit)
}

const DATA = {
  notes: [{ path: 'notes/reading.md' }, { path: 'projects/plan.md' }],
  tasks: [{ path: 'projects/task.ship-it.md', title: 'Ship it', status: 'todo' as const }],
}

describe('mentionCompletions (FR-8)', () => {
  it('offers note completions anchored at the @, when the caret follows @', () => {
    const result = mentionCompletions(ctx('see @'), DATA)
    expect(result).not.toBeNull()
    expect(result!.from).toBe(4) // replace from the @ itself
    expect(result!.options.map((o) => o.label)).toContain('notes/reading.md')
  })

  it('inserts a path-based wiki-link for a note, replacing the @query', () => {
    const result = mentionCompletions(ctx('see @read'), DATA)
    const opt = result!.options.find((o) => o.label === 'notes/reading.md')
    expect(opt?.apply).toBe('[[notes/reading.md]]')
  })

  it('offers task completions that insert a path wiki-link labelled by title', () => {
    const result = mentionCompletions(ctx('ping @'), DATA)
    const opt = result!.options.find((o) => o.apply === '[[projects/task.ship-it.md]]')
    expect(opt).toBeDefined()
    expect(opt!.label).toContain('Ship it')
  })

  it('does not trigger inside an email address (@ preceded by a word char)', () => {
    expect(mentionCompletions(ctx('email foo@bar'), DATA)).toBeNull()
  })

  it('returns null when there is no @ before the caret', () => {
    expect(mentionCompletions(ctx('plain text'), DATA)).toBeNull()
  })

  it('filters candidates by the query after the @ (notes by path, tasks by title)', () => {
    const result = mentionCompletions(ctx('see @read'), DATA)
    const labels = result!.options.map((o) => o.label)
    expect(labels).toContain('notes/reading.md')
    expect(labels).not.toContain('projects/plan.md')
    expect(labels).not.toContain('Ship it')
  })

  it('disables the default CM filter so the @-prefixed query does not re-filter labels', () => {
    // from sits at the @, so CM's own fuzzy filter would match "@read" against the
    // labels and drop everything — our manual filter must be authoritative.
    expect(mentionCompletions(ctx('see @read'), DATA)!.filter).toBe(false)
  })
})
