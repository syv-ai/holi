import { describe, expect, test } from 'vitest'
import { frontmatterRows, frontmatterSchema } from '../src/frontmatter-schema'
import { editYamlMapping } from '../src/yaml-document'

describe('frontmatterSchema', () => {
  test('a task file gets the task vocabulary', () => {
    const schema = frontmatterSchema('projects/task.fix-login.md')!
    expect(schema.map((f) => f.key)).toEqual([
      'status',
      'priority',
      'due',
      'reminder',
      'recurrence',
      'tags',
      'order',
    ])
    expect(schema.find((f) => f.key === 'status')!.kind).toEqual({
      kind: 'enum',
      options: ['todo', 'doing', 'done'],
    })
  })

  test('a note gets what the scaffold writes, and no title', () => {
    const schema = frontmatterSchema('notes/meeting.md')!
    expect(schema.map((f) => f.key)).toEqual(['created', 'tags'])
  })

  test('the agent surface has no schema at all, so it shows YAML', () => {
    // Null is "show the raw text", not "no keys". A skill's frontmatter is a
    // typed interface with a schema of its own and AGENTS.md is prompt text.
    expect(frontmatterSchema('AGENTS.md')).toBeNull()
    expect(frontmatterSchema('.claude/skills/theme/SKILL.md')).toBeNull()
    expect(frontmatterSchema('CLAUDE.md')).toBeNull()
    expect(frontmatterSchema('USER.local.md')).toBeNull()
  })

  test('hidden paths and non-markdown have none either', () => {
    expect(frontmatterSchema('.holi/apps/retro/app.yaml')).toBeNull()
    expect(frontmatterSchema('notes/data.json')).toBeNull()
  })
})

describe('frontmatterRows', () => {
  const schema = frontmatterSchema('task.a.md')!

  test('shows every schema row whether the file has it or not', () => {
    // A field you can fill in without knowing its name.
    expect(frontmatterRows(schema, ['status']).map((f) => f.key)).toEqual([
      'status',
      'priority',
      'due',
      'reminder',
      'recurrence',
      'tags',
    ])
  })

  test('hides `order`, which means nothing to a human', () => {
    expect(frontmatterRows(schema, ['order']).map((f) => f.key)).not.toContain('order')
  })

  test('unknown keys follow, as text, in the order the file has them', () => {
    const rows = frontmatterRows(schema, ['zzz', 'title', 'status'])
    expect(rows.slice(-2).map((f) => f.key)).toEqual(['zzz', 'title'])
    expect(rows.at(-1)!.kind).toEqual({ kind: 'text' })
  })
})

describe('editYamlMapping', () => {
  test('sets a key without disturbing the rest', () => {
    expect(editYamlMapping('status: todo\ndue: 2026-08-25\n', { priority: 'high' })).toBe(
      'status: todo\ndue: 2026-08-25\npriority: high\n',
    )
  })

  test('undefined deletes the key rather than writing a null', () => {
    // A cleared field leaves no `due: null` behind: absent means not set.
    expect(editYamlMapping('status: todo\ndue: 2026-08-25\n', { due: undefined })).toBe(
      'status: todo\n',
    )
  })

  test('clearing the last key leaves nothing, not a literal {}', () => {
    // `yaml` has to spell "a map with no pairs" somehow. The file does not, and
    // `{}` between the fences is a thing nobody typed, kept forever.
    expect(editYamlMapping('status: todo\n', { status: undefined })).toBe('')
  })

  test('keeps comments and key order through a write', () => {
    const before = '# what this task is for\nstatus: todo\n\n# when\ndue: 2026-08-25\n'
    const after = editYamlMapping(before, { status: 'doing' })
    expect(after).toContain('# what this task is for')
    expect(after).toContain('# when')
    expect(after.indexOf('status:')).toBeLessThan(after.indexOf('due:'))
  })

  test('keeps nested structure it was not asked about', () => {
    const before = 'recurrence:\n  frequency: weekly\n  weekdays:\n    - mon\n'
    expect(editYamlMapping(before, { status: 'todo' })).toContain('    - mon')
  })

  test('returns the text unchanged when there is nothing to edit into', () => {
    // Broken YAML is the editor's to fix as text; a write must not eat it.
    const broken = 'status: "unterminated\n'
    expect(editYamlMapping(broken, { status: 'todo' })).toBe(broken)
    expect(editYamlMapping('- a list\n- not a map\n', { status: 'todo' })).toBe(
      '- a list\n- not a map\n',
    )
  })

  test('writes a nested map as real YAML, not as a flow object', () => {
    expect(editYamlMapping('status: todo\n', { recurrence: { frequency: 'weekly' } })).toBe(
      'status: todo\nrecurrence:\n  frequency: weekly\n',
    )
  })
})
