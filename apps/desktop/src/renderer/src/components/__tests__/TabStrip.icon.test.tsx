/**
 * A tab names and marks a file as its tree row does (`pathLabel`/`pathGlyph`):
 * a note has no `.md` and no glyph, an app (a surface tab) no `.app` and its surface's glyph, a path
 * a plugin marks (a task) its mark, anything else its type glyph, and an
 * icon-map emoji beats all of them. Which glyph is which is the tree's tests' question; the strip is
 * tested for the plumbing from the snapshot.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { atom, getDefaultStore } from 'jotai'
import { beforeEach, expect, test } from 'vitest'
import { render, screen } from '@/test/render'
import { FileText } from 'lucide-react'
import type { PathMark, Surface } from '@/plugin-api/types'
import type { Tab } from '@/state/panes'
import { coreContributionAtom } from '@/state/plugins'
import { snapshotAtom } from '@/state/vaults'
import { TabStrip } from '../TabStrip'

/** A surface with a tab per id, as a vault app's is: named by its id. */
const APP_SURFACE: Surface = {
  kind: 'app',
  label: (id) => (id === undefined ? 'App' : (id.split('/').pop() ?? id).replace(/\.app$/, '')),
  icon: FileText,
  render: () => null,
}

const EMPTY = emptyVaultSnapshot()
const store = getDefaultStore()

/** What a plugin marks paths with, as the tasks plugin marks a task's status. */
const MARKS = atom<ReadonlyMap<string, PathMark>>(
  new Map([['task.ship.md', { glyph: <span data-mark="doing" /> }]]),
)

function strip(tab: Tab, name: string, over: { icons?: Record<string, string> } = {}) {
  store.set(snapshotAtom, { ...EMPTY, icons: over.icons ?? {} })
  render(
    <TabStrip tabs={[tab]} active={0} onSelect={() => {}} onPin={() => {}} onClose={() => {}} />,
  )
  // The pill's label button: nothing else in it draws an <svg>, which makes
  // "no glyph" assertable.
  return screen.getByText(name).closest('button')!
}

beforeEach(() => {
  store.set(snapshotAtom, EMPTY)
  store.set(coreContributionAtom, {
    surfaces: [APP_SURFACE],
    rail: [],
    claims: [],
    pathMarks: MARKS,
  })
})

test('a note is named without .md and leads with nothing', () => {
  const pill = strip({ kind: 'note', path: 'notes/roadmap.md' }, 'roadmap')
  expect(pill.innerHTML).not.toContain('<svg')
})

test('a note with an icon-map entry leads with the emoji', () => {
  const pill = strip({ kind: 'note', path: 'notes/roadmap.md' }, 'roadmap', {
    icons: { 'notes/roadmap.md': '🎯' },
  })
  expect(pill.textContent).toContain('🎯')
})

test('the entry is keyed by the tab’s full path, not its filename', () => {
  const pill = strip({ kind: 'note', path: 'notes/roadmap.md' }, 'roadmap', {
    icons: { 'roadmap.md': '🎯' },
  })
  expect(pill.textContent).not.toContain('🎯')
})

test('any other file keeps its extension and its type glyph', () => {
  const pill = strip({ kind: 'note', path: 'docs/msa.pdf' }, 'msa.pdf')
  expect(pill.innerHTML).toContain('<svg')
})

test("a path a plugin marks leads with the plugin's glyph", () => {
  const pill = strip({ kind: 'note', path: 'task.ship.md' }, 'task.ship')
  expect(pill.querySelector('[data-mark="doing"]')).not.toBeNull()
})

test('an app is named without .app and leads with the app glyph', () => {
  const pill = strip({ kind: 'surface', surface: 'app', id: 'Finance/Budget.app' }, 'Budget')
  expect(pill.innerHTML).toContain('<svg')
})
