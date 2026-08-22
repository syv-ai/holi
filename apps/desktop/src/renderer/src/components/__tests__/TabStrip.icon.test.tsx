/**
 * `.holi/icons.json` decorates a tab pill, exactly as it decorates a tree row (D82).
 *
 * The strip's icon is `fileIconFor`, the same function the tree calls, so what
 * is under test here is only the plumbing: the map lives in the snapshot and
 * `tabIcon` is module-level, so the component has to hand it down. Whether an
 * emoji beats the type glyph is `FileTree.icon.test.tsx`'s question, answered
 * once in `fileIconFor`.
 *
 * `active={0}` with one tab is load-bearing: jsdom measures every pill at 0×0,
 * so `tabWindow` keeps only the active one in the DOM (see TabStrip.test.tsx).
 */
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test } from 'vitest'
import { render, screen } from '@/test/render'
import type { Tab } from '@/state/panes'
import { snapshotAtom } from '@/state/vaults'
import { TabStrip } from '../TabStrip'

const EMPTY = { docs: [], tasks: [], broken: [], files: [], dirs: [], icons: {} }
const store = getDefaultStore()

function strip(tab: Tab, icons: Record<string, string> = {}) {
  store.set(snapshotAtom, { ...EMPTY, icons })
  render(
    <TabStrip tabs={[tab]} active={0} onSelect={() => {}} onPin={() => {}} onClose={() => {}} />,
  )
  // The pill's label button — it holds the icon and the name, and nothing else
  // in it draws an <svg>, which is what makes "no glyph" assertable.
  return screen.getByText('roadmap.md').closest('button')!
}

beforeEach(() => {
  store.set(snapshotAtom, EMPTY)
})

test('a note tab with an entry shows the emoji instead of its type glyph', () => {
  const pill = strip({ kind: 'note', path: 'notes/roadmap.md' }, { 'notes/roadmap.md': '🎯' })

  expect(pill.textContent).toContain('🎯')
  expect(pill.innerHTML).not.toContain('<svg')
})

test('a note tab without one keeps the markdown glyph', () => {
  const pill = strip({ kind: 'note', path: 'notes/roadmap.md' })

  expect(pill.textContent).not.toContain('🎯')
  expect(pill.innerHTML).toContain('<svg')
})

test('the entry is keyed by the tab’s full path, not its filename', () => {
  const pill = strip({ kind: 'note', path: 'notes/roadmap.md' }, { 'roadmap.md': '🎯' })

  expect(pill.textContent).not.toContain('🎯')
})
