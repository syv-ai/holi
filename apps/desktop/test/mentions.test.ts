import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it, test } from 'vitest'
import { mentionCompletions } from '../src/renderer/src/editor/mentions'

function ctx(doc: string, pos = doc.length, explicit = false) {
  return new CompletionContext(EditorState.create({ doc }), pos, explicit)
}

/** A claim's group, as the tasks claim offers its open tasks. */
const group = (...items: { path: string; label: string; meta?: string }[]) => ({
  name: 'Tasks',
  items,
})

const DATA = {
  notes: [{ path: 'notes/reading.md' }, { path: 'projects/plan.md' }],
  groups: [group({ path: 'projects/task.ship-it.md', label: 'Ship it' })],
}

describe('mentionCompletions', () => {
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

  it("offers a claim's items as a path wiki-link labelled by its label", () => {
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

  it('filters candidates by the query after the @ (notes by path, the rest by label)', () => {
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
  groups: [
    group(
      { path: 'task.a.md', label: 'Write the retro', meta: 'due 18 Sep' },
      { path: 'task.b.md', label: 'Book the room' },
    ),
  ],
}

test("notes and a claim's group are two sections, notes first", () => {
  const options = mentionCompletions(ctx('@'), RICH)!.options
  const sections = options.map((o) => (typeof o.section === 'string' ? o.section : o.section?.name))
  expect(sections).toEqual(['Notes', 'Notes', 'Tasks', 'Tasks'])
})

test("an item's meta is the trailing pill", () => {
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
    groups: [group({ path: 'task.a.md', label: 'Købe blæk' })],
  }
  expect(mentionCompletions(ctx('@mø'), data)).not.toBeNull()
  expect(mentionCompletions(ctx('@mø'), data)!.options.map((o) => o.label)).toEqual([
    'møder/ørred.md',
  ])
  expect(mentionCompletions(ctx('@kø'), data)!.options.map((o) => o.label)).toEqual(['Købe blæk'])
  // The anchor still sits at the `@`, whatever the query is made of.
  expect(mentionCompletions(ctx('see @å'), data)!.from).toBe(4)
})

// The tree hides dot-prefixed paths and the mention list never did, so `@c`
// offered `.claude/settings.json` alongside your notes.
test('a hidden path is not offered, the way the tree hides it', () => {
  const data = {
    notes: [
      { path: '.claude/settings.json' },
      { path: '.holi/theme.css' },
      { path: 'work/claude-notes.md' },
    ],
    groups: [],
  }
  expect(mentionCompletions(ctx('@'), data)!.options.map((o) => o.label)).toEqual([
    'work/claude-notes.md',
  ])
})
