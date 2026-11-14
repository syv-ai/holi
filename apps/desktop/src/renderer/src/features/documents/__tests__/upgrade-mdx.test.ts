import { emptyVaultSnapshot, TASKS_CLAIM } from '@holi/shared'
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
      mdxUpgradeMove('notes/idea.md', snapshot(), [{ match: (path) => path === 'notes/idea.md' }]),
    ).toBeNull()
    expect(
      mdxUpgradeMove('notes/idea.md', snapshot(), [{ match: (path) => path === 'notes/idea.mdx' }]),
    ).toBeNull()
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
