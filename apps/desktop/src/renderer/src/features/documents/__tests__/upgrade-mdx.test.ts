import { emptyVaultSnapshot, TASKS_CLAIM } from '@holi/shared'
import type { PathClaim } from '@/state/plugin-types'
import { FileText } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { resolveLink } from '../resolve-link'
import { mdxUpgradeMove } from '../upgrade-mdx'

const snapshot = (path = 'notes/idea.md') => ({
  ...emptyVaultSnapshot(),
  docs: [{ path, kind: 'note' as const, updatedAt: '1' }],
})

describe('mdxUpgradeMove', () => {
  it('offers only ordinary, unclaimed Markdown notes with an unused MDX destination', () => {
    expect(mdxUpgradeMove('notes/idea.md', snapshot(), [])).toEqual({
      from: 'notes/idea.md',
      to: 'notes/idea.mdx',
    })
    expect(
      mdxUpgradeMove(
        'notes/idea.md',
        { ...snapshot(), files: [{ path: 'notes/idea.mdx', updatedAt: '1' }] },
        [],
      ),
    ).toBeNull()
    expect(
      mdxUpgradeMove('notes/idea.md', snapshot(), [
        { match: (path) => path === 'notes/idea.md', view: () => null },
      ]),
    ).toBeNull()
    expect(
      mdxUpgradeMove('notes/idea.md', snapshot(), [
        { match: (path) => path === 'notes/idea.mdx', view: () => null },
      ]),
    ).toBeNull()
  })

  it('ignores additive row-menu claims but rejects owned source and destination paths', () => {
    // PDF adds a conversion action to every Markdown row without owning those notes.
    const pdfRowMenuClaim: PathClaim = {
      match: (path) => path.endsWith('.md'),
      rowMenu: [{ label: 'Convert to PDF…', run: () => {} }],
    }
    expect(mdxUpgradeMove('notes/idea.md', snapshot(), [pdfRowMenuClaim])).toEqual({
      from: 'notes/idea.md',
      to: 'notes/idea.mdx',
    })

    const ownershipClaims: PathClaim[] = [
      { match: (path) => path === 'notes/idea.md', view: () => null },
      { match: (path) => path === 'notes/idea.mdx', banner: () => null },
      { match: (path) => path === 'notes/idea.md', folder: { surface: 'app', entry: 'index.md' } },
      {
        match: (path) => path === 'notes/idea.mdx',
        decorate: { icon: FileText, name: () => '', suffix: () => '' },
      },
      { match: (path) => path === 'notes/idea.md', normalize: (text) => text },
      {
        match: (path) => path === 'notes/idea.mdx',
        create: {
          id: 'owned',
          label: 'Owned',
          icon: FileText,
          placeholder: 'Name',
          run: async () => null,
        },
      },
      { match: (path) => path === 'notes/idea.md', hover: () => null },
    ]
    for (const claim of ownershipClaims) {
      expect(mdxUpgradeMove('notes/idea.md', snapshot(), [claim])).toBeNull()
    }
  })

  it.each([
    'task.todo.md',
    '14-11-2026.md',
    '.holi/settings/app.yaml.md',
    '.holi/holis/example.md',
    'notes/idea.local.md',
    'scratchpad.local.md',
    'notes/idea.mdx',
  ])('blocks ineligible path %s', (path) => {
    expect(mdxUpgradeMove(path, snapshot(path), [])).toBeNull()
  })

  it('blocks task claims even when the source appears among documents', () => {
    const path = 'task.todo.md'
    expect(
      mdxUpgradeMove(
        path,
        {
          ...snapshot(path),
          claimed: { [TASKS_CLAIM]: { items: [{ path }], broken: [] } },
        },
        [],
      ),
    ).toBeNull()
  })
})

describe('resolveLink', () => {
  it('opens only an exact MDX file path without adding MDX to note matching', () => {
    const docs = [{ path: 'notes/idea.md' }, { path: 'notes/idea copy.md' }]
    const mdx = [{ path: 'notes/idea.mdx' }]
    expect(resolveLink('notes/idea.mdx', 'index.md', docs, mdx)).toBe('notes/idea.mdx')
    expect(resolveLink('idea.mdx', 'index.md', docs, mdx)).toBeNull()
    expect(resolveLink('idea', 'notes/index.md', docs, mdx)).toBe('notes/idea.md')
  })
})
