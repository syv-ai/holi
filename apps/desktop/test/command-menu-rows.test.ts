/**
 * What the ⌘K command menu lists and in what order, as the pure functions
 * the screen renders verbatim.
 */
import { emptyVaultSnapshot, type VaultSnapshot } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import {
  actionQuery,
  buildPlaces,
  rankActions,
  rankPlaces,
  RECENT_CAP,
  textPlaces,
} from '../src/renderer/src/lib/command-menu-rows'

function snapshot(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    ...emptyVaultSnapshot(),
    docs: [
      { path: 'notes/alpha.md', kind: 'note', updatedAt: '2026-09-01T00:00:00Z' },
      { path: 'notes/beta.md', kind: 'note', updatedAt: '2026-09-03T00:00:00Z' },
      { path: 'roadmap.md', kind: 'note', updatedAt: '2026-09-02T00:00:00Z' },
      { path: '.holi/settings/app.md', kind: 'note', updatedAt: '2026-10-01T00:00:00Z' },
    ],
    files: [{ path: 'notes/deck.pdf', updatedAt: '2026-09-04T00:00:00Z' }],
    icons: { 'notes/alpha.md': '🦊' },
    ignored: ['notes/beta.md'],
    ...over,
  } as VaultSnapshot
}

const places = () => buildPlaces(snapshot(), [{ id: 'tools/Budget.app', label: 'Budget' }])

describe('buildPlaces', () => {
  it('lists visible paths with their folder, emoji and ignored state, then the apps', () => {
    const rows = places()
    expect(rows.map((r) => r.key)).toEqual([
      'notes/alpha.md',
      'notes/beta.md',
      'roadmap.md',
      'notes/deck.pdf',
      'tools/Budget.app',
    ])
    expect(rows[0]).toMatchObject({ kind: 'doc', name: 'alpha', detail: 'notes', emoji: '🦊' })
    expect(rows[1]).toMatchObject({ dim: true })
    expect(rows[2]).not.toHaveProperty('detail')
    expect(rows[3]).toMatchObject({ kind: 'file', name: 'deck.pdf' })
    expect(rows[4]).toMatchObject({ kind: 'app', name: 'Budget', detail: 'tools' })
  })
})

describe('rankPlaces', () => {
  it('untyped: the newest paths, no apps, capped', () => {
    expect(rankPlaces(places(), '').map((r) => r.key)).toEqual([
      'notes/deck.pdf',
      'notes/beta.md',
      'roadmap.md',
      'notes/alpha.md',
    ])
    const many = buildPlaces(
      snapshot({
        docs: Array.from({ length: 20 }, (_, i) => ({
          path: `n${i}.md`,
          kind: 'note' as const,
          updatedAt: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })),
      })
    )
    expect(rankPlaces(many, '')).toHaveLength(RECENT_CAP)
  })

  it('typed: by name first, a folder name still finds the file', () => {
    expect(rankPlaces(places(), 'road')[0]?.key).toBe('roadmap.md')
    expect(rankPlaces(places(), 'budget')[0]?.key).toBe('tools/Budget.app')
    expect(rankPlaces(places(), 'notes').map((r) => r.key)).toContain('notes/alpha.md')
    expect(rankPlaces(places(), 'zzz')).toEqual([])
  })
})

describe('textPlaces', () => {
  it('keeps main order, drops hidden and already-shown paths, carries the snippet', () => {
    const rows = places()
    const shown = rankPlaces(rows, 'road')
    const hits = [
      { path: '.holi/settings/app.md', snippet: 'hidden' },
      { path: 'roadmap.md', snippet: 'already shown' },
      { path: 'notes/beta.md', snippet: '…the road ahead…' },
    ]
    expect(textPlaces(rows, shown, hits)).toEqual([
      expect.objectContaining({ key: 'notes/beta.md', snippet: '…the road ahead…' }),
    ])
  })
})

describe('actions', () => {
  const actions = [
    { id: 'a', label: 'New document' },
    { id: 'b', label: 'Settings', keywords: ['preferences'] },
    { id: 'c', label: 'Split view' },
  ]

  it('keeps the given order untyped, scores label then keywords typed', () => {
    expect(rankActions(actions, '').map((a) => a.id)).toEqual(['a', 'b', 'c'])
    expect(rankActions(actions, 'split').map((a) => a.id)).toEqual(['c'])
    expect(rankActions(actions, 'prefer').map((a) => a.id)).toEqual(['b'])
  })

  it('reads > as actions only', () => {
    expect(actionQuery('> split')).toBe('split')
    expect(actionQuery('>')).toBe('')
    expect(actionQuery('split')).toBeNull()
  })
})
