/**
 * What ⌘P lists and in what order (D102), as the pure function the screen
 * renders verbatim.
 */
import { emptyVaultSnapshot, type VaultSnapshot } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import {
  buildRows,
  commandQuery,
  rankCommands,
  rankRows,
  type PaletteRow,
} from '../src/renderer/src/lib/palette-rows'
import type { RecentEntry } from '../src/renderer/src/lib/recents'

function snapshot(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    ...emptyVaultSnapshot(),
    docs: [
      { path: 'notes/alpha.md', kind: 'note', updatedAt: '2026-09-01T00:00:00Z' },
      { path: 'notes/beta.md', kind: 'note', updatedAt: '2026-09-03T00:00:00Z' },
      { path: '2026-09-21.md', kind: 'daily', updatedAt: '2026-09-21T00:00:00Z' },
      { path: '.holi/settings/app.md', kind: 'note', updatedAt: '2026-01-01T00:00:00Z' },
    ],
    files: [{ path: 'notes/deck.pdf', updatedAt: '2026-09-02T00:00:00Z' }],
    icons: { 'notes/alpha.md': '🦊' },
    ignored: ['notes/beta.md'],
    ...over,
  }
}

const rows = (over: Partial<VaultSnapshot> = {}): PaletteRow[] =>
  buildRows({
    snapshot: snapshot(over),
    appIds: ['plan'],
    sessions: [
      { id: 's1', name: 'refactor', exited: false },
      { id: 's2', name: 'old', exited: true },
    ],
  })

const keys = (list: readonly PaletteRow[]) => list.map((r) => `${r.kind}:${r.key}`)

describe('buildRows', () => {
  it('lists docs, files, apps, live sessions and the five surfaces; hides hidden paths', () => {
    expect(keys(rows())).toEqual([
      'path:notes/alpha.md',
      'path:notes/beta.md',
      'path:2026-09-21.md',
      'path:notes/deck.pdf',
      'app:plan',
      'session:s1',
      'surface:board',
      'surface:agenda',
      'surface:mail',
      'surface:settings',
      'surface:history',
    ])
  })

  it('names a path by its filename with the folder as detail, and carries its emoji', () => {
    const alpha = rows().find((r) => r.key === 'notes/alpha.md')!
    expect(alpha).toMatchObject({ name: 'alpha.md', detail: 'notes', icon: { emoji: '🦊' } })
    const daily = rows().find((r) => r.key === '2026-09-21.md')!
    expect(daily).toMatchObject({ name: '2026-09-21.md', icon: { glyph: 'daily' } })
    expect(daily.detail).toBeUndefined()
  })

  it('dims an ignored path rather than dropping it', () => {
    expect(rows().find((r) => r.key === 'notes/beta.md')?.dim).toBe(true)
    expect(rows().find((r) => r.key === 'notes/alpha.md')?.dim).toBeUndefined()
  })
})

describe('rankRows with nothing typed', () => {
  it('lists the recents first, in order, then paths newest-modified first', () => {
    const recents: RecentEntry[] = [
      { kind: 'app', key: 'plan' },
      { kind: 'path', key: 'notes/alpha.md' },
    ]
    const ranked = rankRows(rows(), '', recents)
    expect(keys(ranked)).toEqual([
      'app:plan',
      'path:notes/alpha.md',
      'path:2026-09-21.md',
      'path:notes/beta.md',
      'path:notes/deck.pdf',
    ])
    expect(ranked.map((r) => r.recent)).toEqual([true, true, false, false, false])
  })

  it('prunes a recent that no longer exists: a dead session, a deleted note', () => {
    const recents: RecentEntry[] = [
      { kind: 'session', key: 's2' },
      { kind: 'path', key: 'gone.md' },
      { kind: 'session', key: 's1' },
    ]
    expect(keys(rankRows(rows(), '', recents)).slice(0, 1)).toEqual(['session:s1'])
  })

  it('caps the list', () => {
    expect(rankRows(rows(), '', [], 2)).toHaveLength(2)
  })
})

describe('rankRows with a query', () => {
  it('scores on the name, so "alp" finds alpha.md first', () => {
    expect(keys(rankRows(rows(), 'alp', []))[0]).toBe('path:notes/alpha.md')
  })

  it('finds a file through its folder, at a discount', () => {
    const ranked = rankRows(rows(), 'notes/deck', [])
    expect(keys(ranked)).toContain('path:notes/deck.pdf')
  })

  it('drops what does not match at all', () => {
    expect(rankRows(rows(), 'zzzz', [])).toEqual([])
  })

  it('breaks a tie by recency', () => {
    const two = buildRows({
      snapshot: snapshot({
        docs: [
          { path: 'a/plan.md', kind: 'note', updatedAt: '2026-01-01T00:00:00Z' },
          { path: 'b/plan.md', kind: 'note', updatedAt: '2026-01-02T00:00:00Z' },
        ],
        files: [],
        icons: {},
        ignored: [],
      }),
      appIds: [],
      sessions: [],
    })
    const ranked = rankRows(two, 'plan', [{ kind: 'path', key: 'b/plan.md' }])
    expect(keys(ranked)[0]).toBe('path:b/plan.md')
    expect(ranked[0]!.recent).toBe(true)
  })

  it('finds a surface and a session by name', () => {
    expect(keys(rankRows(rows(), 'boa', []))[0]).toBe('surface:board')
    expect(keys(rankRows(rows(), 'refac', []))[0]).toBe('session:s1')
  })
})

describe('command mode', () => {
  const commands = [
    { id: 'pane.split', label: 'Split pane', hotkey: '⌘\\' },
    { id: 'tab.close', label: 'Close tab', hotkey: '⌘W' },
    { id: 'board.open', label: 'Open board' },
  ]

  it('commandQuery strips the prefix and its space, and is null otherwise', () => {
    expect(commandQuery('>spl')).toBe('spl')
    expect(commandQuery('>  git')).toBe('git')
    expect(commandQuery('>')).toBe('')
    expect(commandQuery('spl')).toBeNull()
  })

  it('lists recently used first, then the rest by label', () => {
    const ranked = rankCommands(commands, '', [{ kind: 'command', key: 'board.open' }])
    expect(ranked.map((r) => r.command.id)).toEqual(['board.open', 'tab.close', 'pane.split'])
    expect(ranked[0]!.recent).toBe(true)
  })

  it('"spl" scores Split pane first and drops the rest', () => {
    const ranked = rankCommands(commands, 'spl', [])
    expect(ranked.map((r) => r.command.id)).toEqual(['pane.split'])
  })
})
