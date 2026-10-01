/**
 * What ⌘P lists and in what order, as the pure function the screen
 * renders verbatim.
 */
import { emptyVaultSnapshot, type VaultSnapshot } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import {
  bodyRows,
  buildRows,
  commandQuery,
  openTabRows,
  rankCommands,
  rankRows,
  rowId,
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
    // A plugin's item (a live session) and a listed tab (a terminal).
    items: [{ plugin: 'agent', key: 's1', name: 'refactor', dot: 'bg-x' }],
    tabs: [{ surface: 'agent', id: 't1', label: 'Agents' }],
    surfaces: [
      { kind: 'board', label: 'Board' },
      { kind: 'settings', label: 'Settings' },
    ],
    instances: [{ surface: 'app', id: 'Work/plan.app', label: 'plan' }],
  })

const keys = (list: readonly PaletteRow[]) => list.map(rowId)

describe('buildRows', () => {
  it('lists docs, files, instances, plugin items, listed tabs and the surfaces; hides hidden paths', () => {
    expect(keys(rows())).toEqual([
      'path:notes/alpha.md',
      'path:notes/beta.md',
      'path:2026-09-21.md',
      'path:notes/deck.pdf',
      'surface:app:Work/plan.app',
      'item:s1:agent',
      'surface:agent:t1',
      'surface:board',
      'surface:settings',
    ])
  })

  it('names a path by its filename with the folder as detail, and carries its emoji', () => {
    const alpha = rows().find((r) => r.key === 'notes/alpha.md')!
    expect(alpha).toMatchObject({ name: 'alpha.md', detail: 'notes', icon: { emoji: '🦊' } })
    const daily = rows().find((r) => r.key === '2026-09-21.md')!
    expect(daily).toMatchObject({ name: '2026-09-21.md', icon: { glyph: 'daily' } })
    expect(daily.detail).toBeUndefined()
  })

  it('names an instance by its label, with its folder as detail', () => {
    const plan = rows().find((r) => r.id !== undefined)!
    expect(plan).toMatchObject({ key: 'app', id: 'Work/plan.app', name: 'plan', detail: 'Work' })
  })

  it('dims an ignored path rather than dropping it', () => {
    expect(rows().find((r) => r.key === 'notes/beta.md')?.dim).toBe(true)
    expect(rows().find((r) => r.key === 'notes/alpha.md')?.dim).toBeUndefined()
  })
})

describe('rankRows with nothing typed', () => {
  it('lists the recents first, in order, then paths newest-modified first', () => {
    const recents: RecentEntry[] = [
      { kind: 'surface', key: 'app', id: 'Work/plan.app' },
      { kind: 'path', key: 'notes/alpha.md' },
    ]
    const ranked = rankRows(rows(), '', recents)
    expect(keys(ranked)).toEqual([
      'surface:app:Work/plan.app',
      'path:notes/alpha.md',
      'path:2026-09-21.md',
      'path:notes/beta.md',
      'path:notes/deck.pdf',
    ])
    expect(ranked.map((r) => r.recent)).toEqual([true, true, false, false, false])
  })

  it('prunes a recent that no longer exists: a closed terminal, a deleted note', () => {
    const recents: RecentEntry[] = [
      { kind: 'surface', key: 'agent', id: 't2' },
      { kind: 'path', key: 'gone.md' },
      { kind: 'surface', key: 'agent', id: 't1' },
    ]
    expect(keys(rankRows(rows(), '', recents)).slice(0, 1)).toEqual(['surface:agent:t1'])
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
    })
    const ranked = rankRows(two, 'plan', [{ kind: 'path', key: 'b/plan.md' }])
    expect(keys(ranked)[0]).toBe('path:b/plan.md')
    expect(ranked[0]!.recent).toBe(true)
  })

  it('finds a surface and a plugin item by name', () => {
    expect(keys(rankRows(rows(), 'boa', []))[0]).toBe('surface:board')
    expect(keys(rankRows(rows(), 'refac', []))[0]).toBe('item:s1:agent')
  })
})

describe('bodyRows', () => {
  const rows = buildRows({ snapshot: snapshot() })

  it('lists text matches after the name rows, leaving out what those already show', () => {
    const ranked = rankRows(rows, 'alpha', [])
    const out = bodyRows(rows, ranked, [
      { path: 'notes/alpha.md', snippet: 'alpha' },
      { path: 'notes/beta.md', snippet: '…the alpha plan…' },
    ])
    expect(out.map((r) => [r.key, r.snippet])).toEqual([['notes/beta.md', '…the alpha plan…']])
  })

  it('shows only what the palette would list by name: nothing hidden, nothing unknown', () => {
    const out = bodyRows(
      rows,
      [],
      [
        { path: '.holi/settings/app.md', snippet: 'x' },
        { path: 'gone.md', snippet: 'x' },
        { path: 'notes/alpha.md', snippet: 'x' },
      ],
    )
    expect(out.map((r) => r.key)).toEqual(['notes/alpha.md'])
  })
})

describe('openTabRows', () => {
  const tabs = [
    { kind: 'note', path: 'notes/alpha.md' },
    { kind: 'surface', surface: 'app', id: 'Work/plan.app' },
    { kind: 'surface', surface: 'board' },
    { kind: 'surface', surface: 'agent', id: 't1' },
  ] as const

  it('lists the open tabs most recently used first, without the current one', () => {
    const recents: RecentEntry[] = [
      { kind: 'surface', key: 'board' },
      { kind: 'surface', key: 'agent', id: 't1' },
      { kind: 'path', key: 'notes/alpha.md' },
    ]
    const ranked = openTabRows(rows(), [...tabs], { kind: 'surface', surface: 'board' }, recents)
    expect(keys(ranked)).toEqual([
      'surface:agent:t1',
      'path:notes/alpha.md',
      'surface:app:Work/plan.app',
    ])
    expect(ranked.map((r) => r.recent)).toEqual([true, true, false])
  })

  it('is empty with one tab open, so ⌃⇥ has nowhere to go', () => {
    expect(openTabRows(rows(), [tabs[0]], tabs[0], [])).toEqual([])
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
