/**
 * The sidebar's list of vault apps.
 *
 * It is hidden when there is none — the same rule the agenda and mail chips
 * follow — because a launcher whose only destination is "go make one" is a dead
 * end wearing the clothes of a feature.
 */
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/render'
import { AppsSection } from '../AppsSection'
import { appIdsAtom, unregisteredAppIdsAtom } from '../../../state/apps'
import { snapshotAtom } from '../../../state/vaults'
import { emptyWorkspace, workspaceAtom } from '../../../state/panes'

const store = getDefaultStore()

/** A finished app: both the entry document and the manifest that says so. */
function withApps(...ids: string[]) {
  withFiles(...ids.flatMap((id) => [`${id}/index.html`, `${id}/app.yaml`]))
}

/** Raw paths under `.holi/apps/`, for the half-written cases. */
function withFiles(...relPaths: string[]) {
  store.set(snapshotAtom, {
    docs: [],
    tasks: [],
    broken: [],
    dirs: [],
    files: relPaths.map((p) => ({ path: `.holi/apps/${p}`, updatedAt: '' })),
  })
}

beforeEach(() => {
  store.set(workspaceAtom, emptyWorkspace())
})

test('renders nothing at all when the vault has no apps', () => {
  withApps()
  const { container } = render(<AppsSection />)
  expect(container.innerHTML).toBe('')
})

test('lists the apps in sorted order', () => {
  withApps('retro-board', 'burndown')
  render(<AppsSection />)
  const names = screen.getAllByRole('button').map((b) => b.textContent)
  expect(names).toEqual(['burndown', 'retro-board'])
})

test('clicking one opens its tab', async () => {
  withApps('retro-board', 'burndown')
  render(<AppsSection />)
  await userEvent.click(screen.getByRole('button', { name: 'retro-board' }))
  expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([{ kind: 'app', appId: 'retro-board' }])
})

test('a manifest and an entry document together register the app', () => {
  withFiles('retro-board/index.html', 'retro-board/app.yaml')
  expect(store.get(appIdsAtom)).toEqual(['retro-board'])
  expect(store.get(unregisteredAppIdsAtom)).toEqual([])
})

test('a manifest alone does not register — the manifest says finished, not exists', () => {
  withFiles('retro-board/app.yaml')
  expect(store.get(appIdsAtom)).toEqual([])
  expect(store.get(unregisteredAppIdsAtom)).toEqual([])
})

test('an entry document alone does not register, but is not forgotten either', () => {
  withFiles('retro-board/index.html', 'retro-board/app.js')
  expect(store.get(appIdsAtom)).toEqual([])
  expect(store.get(unregisteredAppIdsAtom)).toEqual(['retro-board'])
})

test('a nested manifest does not register a second app', () => {
  withFiles('retro-board/index.html', 'retro-board/app.yaml', 'retro-board/sub/app.yaml')
  expect(store.get(appIdsAtom)).toEqual(['retro-board'])
})

test('a nested entry document does not become an unregistered app', () => {
  withFiles('retro-board/sub/index.html')
  expect(store.get(appIdsAtom)).toEqual([])
  expect(store.get(unregisteredAppIdsAtom)).toEqual([])
})

test('the unregistered list is sorted and excludes the registered', () => {
  withFiles('zeta/index.html', 'alpha/index.html', 'done/index.html', 'done/app.yaml')
  expect(store.get(appIdsAtom)).toEqual(['done'])
  expect(store.get(unregisteredAppIdsAtom)).toEqual(['alpha', 'zeta'])
})
