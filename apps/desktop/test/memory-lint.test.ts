/**
 * The memory lint at its pure seam. It is a shipped vault file (plain node, no
 * Holi), so it is imported from where it ships.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs vault file with no type declarations
import { lintMemory } from '../src/plugins/agent/main/claude/vault/shipped/.claude/skills/memory/lint.mjs'

interface Finding {
  path: string
  kind: string
  message: string
}

const memory = (fields: string, body = 'The fact.') => `---\n${fields}\n---\n${body}\n`
const ok = memory('type: convention\ndescription: one line')

function lint(files: Record<string, string>, existing: string[] = []): Finding[] {
  const all = new Set([...Object.keys(files), ...existing])
  return lintMemory(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    (path: string) => all.has(path),
  )
}

const kinds = (findings: Finding[]) => findings.map((f) => `${f.path} ${f.kind}`)

describe('memory lint', () => {
  it('finds nothing in well-formed, linked memory', () => {
    expect(
      lint(
        {
          '.holi/memory/a.md': memory(
            'type: convention\ndescription: first',
            'See [[.holi/memory/b.md|B]] and [[notes/plan.md]].',
          ),
          '.holi/memory/b.md': memory('type: convention\ndescription: second'),
        },
        ['notes/plan.md'],
      ),
    ).toEqual([])
  })

  it('flags missing, unclosed and YAML-breaking frontmatter', () => {
    const findings = lint({
      '.holi/memory/none.md': 'Just a body.\n',
      '.holi/memory/open.md': '---\ntype: x\nThe fact.\n',
      '.holi/memory/no-type.md': memory('description: has one'),
      '.holi/memory/colon.md': memory('type: environment\ndescription: node is broken: use pnpm'),
      '.holi/memory/quoted.md': memory('type: environment\ndescription: "quoted: fine"'),
      '.holi/memory/url.md': memory('type: reference\ndescription: see https://example.com'),
    })
    expect(kinds(findings)).toEqual([
      '.holi/memory/colon.md frontmatter',
      '.holi/memory/no-type.md frontmatter',
      '.holi/memory/none.md frontmatter',
      '.holi/memory/open.md frontmatter',
    ])
  })

  it('tells a broken memory link from a stale reference, and skips code', () => {
    const findings = lint({
      '.holi/memory/a.md': memory(
        'type: convention\ndescription: a',
        [
          '[[.holi/memory/gone.md]] [[notes/moved.md|Old]]',
          'Inline `[[.holi/memory/example.md]]` is an example.',
          '```',
          '[[also/an-example.md]]',
          '```',
        ].join('\n'),
      ),
    })
    expect(findings.map((f) => f.kind)).toEqual(['broken-link', 'stale'])
    expect(findings[0]!.message).toContain('.holi/memory/gone.md')
    expect(findings[1]!.message).toContain('notes/moved.md')
  })

  it('flags a shared memory linking a personal one, not the reverse', () => {
    const findings = lint({
      '.holi/memory/shared.md': memory(
        'type: person\ndescription: shared',
        '[[.holi/memory/me.local.md]]',
      ),
      '.holi/memory/me.local.md': memory(
        'type: person\ndescription: mine',
        '[[.holi/memory/shared.md]]',
      ),
    })
    expect(kinds(findings)).toEqual(['.holi/memory/shared.md broken-link'])
  })

  it('reports likely duplicates once per group, by description or by title', () => {
    const findings = lint({
      '.holi/memory/a.md': memory('type: x\ndescription: Use pnpm exec!'),
      '.holi/memory/b.md': memory('type: y\ndescription: use  PNPM exec'),
      '.holi/memory/c.md': memory('type: x\ndescription: other\ntitle: Same name'),
      '.holi/memory/d.md': memory('type: x\ndescription: else', '# Same Name\n\nThe fact.'),
      '.holi/memory/e.md': ok,
    })
    expect(kinds(findings)).toEqual(['.holi/memory/a.md duplicate', '.holi/memory/c.md duplicate'])
    expect(findings[0]!.message).toContain('.holi/memory/b.md')
    expect(findings[1]!.message).toContain('.holi/memory/d.md')
  })

  it('is deterministic: the same files give the same findings in any order', () => {
    const files = {
      '.holi/memory/b.md': 'no frontmatter\n',
      '.holi/memory/a.md': memory('type: x\ndescription: d', '[[gone.md]]'),
    }
    const reversed = Object.fromEntries(Object.entries(files).reverse())
    expect(lint(files)).toEqual(lint(reversed))
  })
})
