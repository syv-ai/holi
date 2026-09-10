/**
 * Which markdown files are notes, and what a note is born with (#17).
 *
 * The shape is shared because three places have to agree on it: the file-tree
 * `+`, the `scaffold-md` pre-commit transform, and anything that later has to
 * recognise Holi's own write.
 */
import { describe, expect, it } from 'vitest'
import { hasFrontmatter, scaffoldFrontmatter, scaffoldNoteText, wantsScaffold } from '../src/scaffold-md'

describe('scaffoldNoteText', () => {
  it('is created + empty tags, and deliberately no title', () => {
    expect(scaffoldNoteText('2026-07-23')).toBe('---\ncreated: 2026-07-23\ntags: []\n---\n\n')
  })
})

describe('hasFrontmatter', () => {
  it('is true for a fenced block', () => {
    expect(hasFrontmatter('---\na: 1\n---\n\nbody')).toBe(true)
  })

  it('is true for an UNTERMINATED one — the file is mid-edit', () => {
    expect(hasFrontmatter('---\na: 1\n')).toBe(true)
  })

  it('is false for prose, and for a thematic break that is not at the top', () => {
    expect(hasFrontmatter('# Title\n\n---\n')).toBe(false)
  })

  it('sees through CRLF', () => {
    expect(hasFrontmatter('---\r\na: 1\r\n---\r\n')).toBe(true)
  })
})

describe('wantsScaffold', () => {
  it('takes an ordinary note anywhere in the tree', () => {
    expect(wantsScaffold('plan.md')).toBe(true)
    expect(wantsScaffold('projects/q2/roadmap.md')).toBe(true)
  })

  it('refuses the agent surface, where frontmatter is prompt text', () => {
    expect(wantsScaffold('CLAUDE.md')).toBe(false)
    expect(wantsScaffold('AGENTS.md')).toBe(false)
    expect(wantsScaffold('MEMORY.md')).toBe(false)
    expect(wantsScaffold('USER.local.md')).toBe(false)
    expect(wantsScaffold('.claude/skills/theme/SKILL.md')).toBe(false)
  })

  it('refuses a memory file, whose frontmatter is type + description', () => {
    // D89, and this one has teeth beyond tidiness: `memory/index.md` is
    // GENERATED, so a `created:`/`tags:` block prepended here would be rewritten
    // away by the memory-index transform on the same commit, every commit.
    expect(wantsScaffold('memory/shell-quirks.md')).toBe(false)
    expect(wantsScaffold('memory/people/ada.md')).toBe(false)
    expect(wantsScaffold('memory/index.md')).toBe(false)
  })

  it('takes a note that merely shares a managed name deeper in the tree', () => {
    expect(wantsScaffold('notes/AGENTS.md')).toBe(true)
  })

  it('refuses a task file, whose serializer owns its frontmatter', () => {
    expect(wantsScaffold('task.fix-login.md')).toBe(false)
    expect(wantsScaffold('projects/task.fix-login.md')).toBe(false)
  })

  it('refuses anything hidden', () => {
    expect(wantsScaffold('.holi/apps/thing/README.md')).toBe(false)
    expect(wantsScaffold('sub/.private/x.md')).toBe(false)
  })

  it('refuses non-markdown', () => {
    expect(wantsScaffold('data.json')).toBe(false)
    expect(wantsScaffold('notes/plan.txt')).toBe(false)
  })
})

describe('scaffoldFrontmatter', () => {
  it('prepends the block', () => {
    expect(scaffoldFrontmatter('body\n', '2026-09-09')).toBe(
      '---\ncreated: 2026-09-09\ntags: []\n---\n\nbody\n',
    )
  })

  it('is a no-op on a file that already has a block, which is what makes it idempotent', () => {
    const text = '---\ntype: daily-note\ndate: 2026-09-09\n---\n\n# 09-09-2026\n'
    expect(scaffoldFrontmatter(text, '2026-09-09')).toBe(text)
    expect(scaffoldFrontmatter(scaffoldFrontmatter('body\n', 'x'), 'y')).toBe(
      scaffoldFrontmatter('body\n', 'x'),
    )
  })
})
