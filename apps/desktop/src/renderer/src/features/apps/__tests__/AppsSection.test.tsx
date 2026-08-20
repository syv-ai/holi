/**
 * The sidebar's list of vault apps.
 *
 * It is hidden when there is none — the same rule the agenda and mail chips
 * follow — because a launcher whose only destination is "go make one" is a dead
 * end wearing the clothes of a feature.
 */
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/render'
import { AppsSection } from '../AppsSection'
import {
  appDirIdsAtom,
  appIdsAtom,
  appsSectionOpenAtom,
  hasAppsAtom,
  unregisteredAppIdsAtom,
} from '../../../state/apps'
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
  store.set(appsSectionOpenAtom, true)
})

test('renders nothing at all when the vault has no apps', () => {
  withApps()
  const { container } = render(<AppsSection />)
  expect(container.innerHTML).toBe('')
})

test('lists the apps in sorted order', () => {
  withApps('retro-board', 'burndown')
  render(<AppsSection />)
  expect(rowNames()).toEqual(['burndown', 'retro-board'])
})

test('shows an unfinished app after the finished ones, and says what it needs', async () => {
  // It was computed and rendered nowhere, which is the exact failure this list
  // exists to remove: the app does not appear and there is nowhere to look.
  withFiles('burndown/index.html', 'burndown/app.yaml', 'half-done/index.html')
  render(<AppsSection />)

  expect(rowNames()).toEqual(['burndown', 'half-done'])
  await userEvent.hover(screen.getByRole('button', { name: 'half-done' }))
  expect(await screen.findByText(/has no app.yaml yet/)).toBeTruthy()
})

test('clicking an unfinished app opens nothing — there is no manifest to open it by', async () => {
  withFiles('half-done/index.html')
  render(<AppsSection />)

  await userEvent.click(screen.getByRole('button', { name: 'half-done' }))

  expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([])
})

test('the section appears for an unfinished app alone, with no finished one', () => {
  withFiles('half-done/index.html')
  const { container } = render(<AppsSection />)
  expect(container.innerHTML).not.toBe('')
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

/** The row labels, in render order — finished first, then unfinished. The
 *  section heading is a button too (it toggles the panel), so it is excluded by
 *  the `aria-expanded` it carries and the rows do not. */
function rowNames(): string[] {
  return screen
    .getAllByRole('button')
    .filter((b) => !b.hasAttribute('aria-expanded'))
    .map((b) => b.textContent ?? '')
}

test('a directory with neither file still counts as a taken id', () => {
  // Renaming onto it would be a rename onto occupied ground even though it is
  // an app by no definition and appears in neither list.
  withFiles('half-done/index.html', 'squatter/style.css')

  expect(store.get(appIdsAtom)).toEqual([])
  expect(store.get(unregisteredAppIdsAtom)).toEqual(['half-done'])
  expect([...store.get(appDirIdsAtom)].sort()).toEqual(['half-done', 'squatter'])
})

test('renaming opens a field seeded with the current id, and Escape puts the row back', async () => {
  withApps('retro-board')
  render(<AppsSection />)

  await openMenuOn('retro-board')
  await userEvent.click(screen.getByText('Rename…'))

  const field = screen.getByLabelText<HTMLInputElement>('rename retro-board')
  expect(field.value).toBe('retro-board')

  await userEvent.keyboard('{Escape}')
  expect(screen.getByRole('button', { name: 'retro-board' })).toBeTruthy()
})

test('an id the rule refuses is reported under the field, and nothing is sent', async () => {
  withApps('retro-board')
  render(<AppsSection />)

  await openMenuOn('retro-board')
  await userEvent.click(screen.getByText('Rename…'))
  await userEvent.clear(screen.getByLabelText('rename retro-board'))
  await userEvent.type(screen.getByLabelText('rename retro-board'), 'Retro Board{Enter}')

  expect(screen.getByText(/lowercase letters, digits and dashes/)).toBeTruthy()
  // Still a field, not a row: the refusal is something to fix, not to dismiss.
  expect(screen.queryByRole('button', { name: 'retro-board' })).toBeNull()
})

test('an id another app already holds is refused by name', async () => {
  withApps('retro-board', 'burndown')
  render(<AppsSection />)

  await openMenuOn('retro-board')
  await userEvent.click(screen.getByText('Rename…'))
  await userEvent.clear(screen.getByLabelText('rename retro-board'))
  await userEvent.type(screen.getByLabelText('rename retro-board'), 'burndown{Enter}')

  expect(screen.getByText('burndown already exists')).toBeTruthy()
})

test('the menu offers to finish an unfinished app, and to open a finished one', async () => {
  withFiles('burndown/index.html', 'burndown/app.yaml', 'half-done/index.html')
  render(<AppsSection />)

  await openMenuOn('half-done')
  expect(screen.getByText('Finish this app')).toBeTruthy()
  expect(screen.queryByText('Open')).toBeNull()
  await userEvent.keyboard('{Escape}')

  await openMenuOn('burndown')
  expect(screen.getByText('Open')).toBeTruthy()
  expect(screen.queryByText('Finish this app')).toBeNull()
})

test('Edit Source opens the entry document as a pinned note tab', async () => {
  withApps('retro-board')
  render(<AppsSection />)

  await openMenuOn('retro-board')
  await userEvent.click(screen.getByText('Edit Source'))

  // Pinned, not preview: opening an app's source is a deliberate act, and a
  // preview tab would be replaced by the next thing clicked in the tree.
  expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([
    { kind: 'note', path: '.holi/apps/retro-board/index.html' },
  ])
})

test('Copy Path copies the app directory, not a file inside it', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  withApps('retro-board')
  render(<AppsSection />)

  await openMenuOn('retro-board')
  await userEvent.click(screen.getByText('Copy Path'))

  expect(writeText).toHaveBeenCalledWith('.holi/apps/retro-board')
  vi.unstubAllGlobals()
})

/** Right-click a row and wait for its menu. */
async function openMenuOn(appId: string): Promise<void> {
  await userEvent.pointer({
    target: screen.getByRole('button', { name: appId }),
    keys: '[MouseRight]',
  })
  await screen.findByRole('menu')
}

test('hasApps is what Shell asks before it builds the panel at all', () => {
  // A collapsible panel cannot be conditional on its own contents: an empty one
  // still claims a slice of the column and still draws a handle above it.
  withApps()
  expect(store.get(hasAppsAtom)).toBe(false)

  withFiles('half-done/index.html')
  expect(store.get(hasAppsAtom)).toBe(true)
})

test('the heading toggles the section, and says which way it is', async () => {
  withApps('retro-board')
  render(<AppsSection />)

  const heading = screen.getByRole('button', { name: 'apps' })
  expect(heading.getAttribute('aria-expanded')).toBe('true')

  await userEvent.click(heading)

  expect(store.get(appsSectionOpenAtom)).toBe(false)
  expect(screen.getByRole('button', { name: 'apps' }).getAttribute('aria-expanded')).toBe('false')
})

test('a collapsed section still renders its heading — that is what reopens it', () => {
  // The panel collapses to the header row rather than to zero, so the control
  // that expands it again does not vanish with the thing it controls.
  store.set(appsSectionOpenAtom, false)
  withApps('retro-board')
  render(<AppsSection />)

  expect(screen.getByRole('button', { name: 'apps' })).toBeTruthy()
})
