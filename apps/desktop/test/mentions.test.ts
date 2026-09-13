import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it, test } from 'vitest'
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

// `DATA` is already taken at module scope in this file; this is the richer one.
const RICH = {
  notes: [{ path: 'work/retro.md', icon: '📓' }, { path: 'work/plan.md' }],
  tasks: [
    { path: 'task.a.md', title: 'Write the retro', status: 'doing' as const, due: '2026-09-18' },
    { path: 'task.b.md', title: 'Book the room', status: 'todo' as const },
  ],
}

test('notes and tasks are two sections, notes first', () => {
  const options = mentionCompletions(ctx('@'), RICH)!.options
  const sections = options.map((o) => (typeof o.section === 'string' ? o.section : o.section?.name))
  expect(sections.filter((s) => s === 'Notes')).toHaveLength(2)
  expect(sections.filter((s) => s === 'Tasks')).toHaveLength(2)
})

test("a task's glyph carries its status, so the row does not say it twice", () => {
  const options = mentionCompletions(ctx('@'), RICH)!.options
  expect(options.find((o) => o.label === 'Write the retro')?.type).toBe('holi-task-doing')
  expect(options.find((o) => o.label === 'Book the room')?.type).toBe('holi-task-todo')
  // The status used to be repeated in `detail`. The glyph says it now.
  expect(options.find((o) => o.label === 'Write the retro')?.detail).toBeUndefined()
})

test('a due date is the trailing pill, humanised the way the board writes it', () => {
  const options = mentionCompletions(ctx('@'), RICH)!.options
  const withDue = options.find((o) => o.label === 'Write the retro')
  expect((withDue as { meta?: string }).meta).toBe('due 18 Sep')
  const without = options.find((o) => o.label === 'Book the room')
  expect((without as { meta?: string }).meta).toBeUndefined()
})

test("a note wears the vault's own emoji when it has one", () => {
  const options = mentionCompletions(ctx('@'), RICH)!.options
  expect((options.find((o) => o.label === 'work/retro.md') as { emoji?: string }).emoji).toBe('📓')
  expect(
    (options.find((o) => o.label === 'work/plan.md') as { emoji?: string }).emoji,
  ).toBeUndefined()
})

// `\w` is ASCII-only in JavaScript, so a mention regex built from it stops
// matching at the first non-ASCII letter, the source returns null, and
// CodeMirror closes the popup. Reported in the running app: typing `@` then a
// Danish letter dismissed the list.
test('a mention survives letters outside ASCII', () => {
  const data = {
    notes: [{ path: 'møder/ørred.md' }, { path: 'work/plan.md' }],
    tasks: [{ path: 'task.a.md', title: 'Købe blæk', status: 'todo' as const }],
  }
  expect(mentionCompletions(ctx('@mø'), data)).not.toBeNull()
  expect(mentionCompletions(ctx('@mø'), data)!.options.map((o) => o.label)).toEqual([
    'møder/ørred.md',
  ])
  expect(mentionCompletions(ctx('@kø'), data)!.options.map((o) => o.label)).toEqual(['Købe blæk'])
  // The anchor still sits at the `@`, whatever the query is made of.
  expect(mentionCompletions(ctx('see @å'), data)!.from).toBe(4)
})

