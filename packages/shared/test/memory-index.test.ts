/**
 * The memory indexer (D89).
 *
 * The theme running through all of it: **this thing maintains, it never
 * enforces**. Every test below that feeds it a broken file asserts that it
 * produced a sensible entry rather than that it complained, because the caller
 * is a pre-commit transform and FR-9 says a transform may never block a commit.
 */
import { describe, expect, it } from 'vitest'
import {
  MEMORY_INDEX,
  MEMORY_INDEX_EMPTY,
  MEMORY_INDEX_HEADER,
  isMemoryPath,
  isSharedMemoryPath,
  readMemoryEntry,
  renderMemoryIndex,
} from '../src/memory-index'

const withFrontmatter = (yaml: string, body = 'The fact.\n') => `---\n${yaml}\n---\n\n${body}`

describe('isMemoryPath', () => {
  it('is a prefix match on the directory, not an exact filename', () => {
    expect(isMemoryPath('memory/shell.md')).toBe(true)
    expect(isMemoryPath('memory/people/ada.md')).toBe(true)
  })

  it('excludes the generated index, which would otherwise index itself', () => {
    expect(isMemoryPath(MEMORY_INDEX)).toBe(false)
  })

  it('leaves an ordinary note that happens to live under a memory folder alone', () => {
    // The same rule `AGENTS.md` already gets: the path is the whole identity.
    expect(isMemoryPath('notes/memory/x.md')).toBe(false)
    expect(isMemoryPath('memory.md')).toBe(false)
  })

  it('is markdown only', () => {
    expect(isMemoryPath('memory/diagram.png')).toBe(false)
  })
})

describe('isSharedMemoryPath', () => {
  // The one rule here whose failure is worse than untidiness: the index is
  // committed, and a personal memory's title must appear in no committed file.
  it('refuses a personal memory', () => {
    expect(isSharedMemoryPath('memory/salary.local.md')).toBe(false)
    expect(isSharedMemoryPath('memory/people/ada.local.md')).toBe(false)
  })

  it('accepts a shared one', () => {
    expect(isSharedMemoryPath('memory/shell.md')).toBe(true)
  })
})

describe('readMemoryEntry fills gaps rather than refusing them', () => {
  it('takes all three keys from frontmatter when they are there', () => {
    const entry = readMemoryEntry(
      'memory/shell.md',
      withFrontmatter('type: environment\ntitle: Shell quirks\ndescription: bare node is broken'),
    )
    expect(entry).toEqual({
      path: 'memory/shell.md',
      type: 'environment',
      title: 'Shell quirks',
      description: 'bare node is broken',
    })
  })

  it('falls back to `note` with no type', () => {
    expect(readMemoryEntry('memory/x.md', withFrontmatter('title: X')).type).toBe('note')
  })

  it('falls back to the H1 with no title', () => {
    const entry = readMemoryEntry(
      'memory/x.md',
      withFrontmatter('type: convention', '# Plan style\n\nPlans carry contracts.\n'),
    )
    expect(entry.title).toBe('Plan style')
  })

  it('falls back to the filename with no title and no H1', () => {
    expect(
      readMemoryEntry('memory/people/ada-holm.md', withFrontmatter('type: person')).title,
    ).toBe('ada-holm')
  })

  it('falls back to the first sentence of the body with no description', () => {
    const entry = readMemoryEntry(
      'memory/x.md',
      withFrontmatter('type: convention', 'Plans stay lean. They carry contracts and gotchas.\n'),
    )
    expect(entry.description).toBe('Plans stay lean.')
  })

  it('does not repeat the H1 as the description', () => {
    // The H1 IS the title; printing it twice on one line says nothing twice.
    const entry = readMemoryEntry('memory/x.md', '# Plan style\n\nPlans stay lean.\n')
    expect(entry.title).toBe('Plan style')
    expect(entry.description).toBe('Plans stay lean.')
  })

  it('treats a file with no frontmatter at all as a memory, not an error', () => {
    const entry = readMemoryEntry('memory/loose.md', 'Just a fact someone typed.\n')
    expect(entry).toEqual({
      path: 'memory/loose.md',
      type: 'note',
      title: 'loose',
      description: 'Just a fact someone typed.',
    })
  })

  it('treats malformed YAML exactly as if it were absent', () => {
    const entry = readMemoryEntry('memory/half.md', '---\ntype: [unclosed\n---\n\nThe fact.\n')
    expect(entry.type).toBe('note')
    expect(entry.description).toBe('The fact.')
  })

  it('survives an unterminated frontmatter fence — a file mid-edit', () => {
    // splitFrontmatter throws here, and a memory being typed must not be able to
    // take a commit down with it.
    const entry = readMemoryEntry('memory/typing.md', '---\ntype: convention\n')
    expect(entry.type).toBe('note')
    expect(entry.title).toBe('typing')
  })

  it('reads frontmatter that is a bare scalar or a list as absent', () => {
    expect(readMemoryEntry('memory/a.md', '---\njust a string\n---\n\nBody.\n').type).toBe('note')
    expect(readMemoryEntry('memory/b.md', '---\n- one\n- two\n---\n\nBody.\n').type).toBe('note')
  })

  it('falls through an emptied field rather than rendering a blank', () => {
    const entry = readMemoryEntry('memory/x.md', withFrontmatter('type: "   "\ntitle: ""'))
    expect(entry.type).toBe('note')
    expect(entry.title).toBe('x')
  })

  it('truncates a long description at a word boundary', () => {
    const long = `${'word '.repeat(60)}end.`
    const entry = readMemoryEntry('memory/x.md', withFrontmatter('type: t', long))
    expect(entry.description.length).toBeLessThanOrEqual(121)
    expect(entry.description.endsWith('…')).toBe(true)
    expect(entry.description).not.toMatch(/wor…$/)
  })

  it('collapses a multi-line description to one line', () => {
    // Everything it emits sits inside one list item, where a newline ends the
    // entry early.
    const entry = readMemoryEntry('memory/x.md', withFrontmatter('type: t', 'One\nfact\nhere.\n'))
    expect(entry.description).toBe('One fact here.')
  })
})

describe('renderMemoryIndex', () => {
  const entry = (path: string, type: string, title: string, description = '') => ({
    path,
    type,
    title,
    description,
  })

  it('groups by type, sorts the types, and sorts entries by path within one', () => {
    const out = renderMemoryIndex([
      entry('memory/z.md', 'convention', 'Z'),
      entry('memory/shell.md', 'environment', 'Shell'),
      entry('memory/a.md', 'convention', 'A'),
    ])
    expect(out).toBe(
      `${MEMORY_INDEX_HEADER}\n\n` +
        '## convention\n\n- [[memory/a.md|A]]\n- [[memory/z.md|Z]]\n\n' +
        '## environment\n\n- [[memory/shell.md|Shell]]\n',
    )
  })

  it('prints the description after an em dash when there is one', () => {
    const out = renderMemoryIndex([entry('memory/a.md', 'convention', 'A', 'plans stay lean')])
    expect(out).toContain('- [[memory/a.md|A]] — plans stay lean')
  })

  it('gives the empty vault a body that says so', () => {
    expect(renderMemoryIndex([])).toBe(MEMORY_INDEX_EMPTY)
  })

  it('substitutes a `]` in a title, which would otherwise break the link', () => {
    // The grammar is `\[\[([^\]\n]+)\]\]` and has no escape sequence, so a `]`
    // ends the body early and the reader gets raw brackets instead of a link.
    const out = renderMemoryIndex([entry('memory/a.md', 't', 'The [redacted] fact')])
    expect(out).toContain('[[memory/a.md|The [redacted) fact]]')
  })

  it('leaves a `|` in a title alone, because the parser splits on the first one', () => {
    const out = renderMemoryIndex([entry('memory/a.md', 't', 'A | B')])
    expect(out).toContain('[[memory/a.md|A | B]]')
  })

  it('ends with exactly one newline, so `normalize-md` has nothing to tidy', () => {
    // The two transforms would otherwise take turns rewriting this file.
    for (const out of [
      renderMemoryIndex([]),
      renderMemoryIndex([entry('memory/a.md', 't', 'A')]),
    ]) {
      expect(out.endsWith('\n')).toBe(true)
      expect(out.endsWith('\n\n')).toBe(false)
      expect(out).not.toMatch(/[ \t]+$/m)
    }
  })
})
