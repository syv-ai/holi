/**
 * A tab names and marks a file as its tree row does (`pathLabel`/`pathGlyph`):
 * a note has no `.md` and no glyph, an app no `.app` and the app glyph, a task
 * its status, anything else its type glyph, and an icon-map emoji (D82) beats
 * all of them. Which glyph is which is the tree's tests' question; the strip is
 * tested for the plumbing from the snapshot.
 */
import { emptyVaultSnapshot, type Task } from '@holi/shared'
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test } from 'vitest'
import { render, screen } from '@/test/render'
import type { Tab } from '@/state/panes'
import { snapshotAtom } from '@/state/vaults'
import { TabStrip } from '../TabStrip'

const EMPTY = emptyVaultSnapshot()
const store = getDefaultStore()

function strip(
  tab: Tab,
  name: string,
  over: { icons?: Record<string, string>; tasks?: Task[] } = {},
) {
  store.set(snapshotAtom, { ...EMPTY, icons: over.icons ?? {}, tasks: over.tasks ?? [] })
  render(
    <TabStrip tabs={[tab]} active={0} onSelect={() => {}} onPin={() => {}} onClose={() => {}} />,
  )
  // The pill's label button: nothing else in it draws an <svg>, which makes
  // "no glyph" assertable.
  return screen.getByText(name).closest('button')!
}

beforeEach(() => {
  store.set(snapshotAtom, EMPTY)
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

test('a task leads with its status glyph', () => {
  const task = { path: 'task.ship.md', title: 'Ship', status: 'doing', tags: [] } as unknown as Task
  const pill = strip({ kind: 'note', path: 'task.ship.md' }, 'task.ship', { tasks: [task] })
  expect(pill.innerHTML).toContain('var(--task-doing)')
})

test('an app is named without .app and leads with the app glyph', () => {
  const pill = strip({ kind: 'app', path: 'Finance/Budget.app' }, 'Budget')
  expect(pill.innerHTML).toContain('<svg')
})
