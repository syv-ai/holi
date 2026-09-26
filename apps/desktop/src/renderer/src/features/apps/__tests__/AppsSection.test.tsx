/**
 * The sidebar's list of vault apps.
 *
 * It is hidden when there is none, because a launcher whose only destination is
 * "go make one" is a dead end.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/render'
import { AppsSection } from '../AppsSection'
import {
  appPathsAtom,
  appsSectionOpenAtom,
  hasAppsAtom,
  unregisteredAppPathsAtom,
} from '../../../state/apps'
import { snapshotAtom } from '../../../state/vaults'
import { emptyWorkspace, workspaceAtom } from '../../../state/panes'

const store = getDefaultStore()

/** Finished apps at the root: both the entry document and the manifest. */
function withApps(...names: string[]) {
  withFiles(...names.flatMap((n) => [`${n}.app/index.html`, `${n}.app/app.yaml`]))
}

/** Raw vault paths, for the half-written cases. */
function withFiles(...paths: string[]) {
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    files: paths.map((path) => ({ path, updatedAt: '' })),
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

test('lists the apps by name, wherever in the vault they are filed', () => {
  withFiles(
    'Team/retro-board.app/index.html',
    'Team/retro-board.app/app.yaml',
    'burndown.app/index.html',
    'burndown.app/app.yaml',
  )
  render(<AppsSection />)
  expect(rowNames()).toEqual(['burndown', 'retro-board'])
})

test('shows an unfinished app after the finished ones, and says what it needs', async () => {
  // The failure this list exists to remove: the app does not appear and there
  // is nowhere to look.
  withFiles('burndown.app/index.html', 'burndown.app/app.yaml', 'half-done.app/index.html')
  render(<AppsSection />)

  expect(rowNames()).toEqual(['burndown', 'half-done'])
  await userEvent.hover(screen.getByRole('button', { name: 'half-done' }))
  expect(await screen.findByText(/has no app.yaml yet/)).toBeTruthy()
})

test('clicking an unfinished app opens nothing — there is no manifest to open it by', async () => {
  withFiles('half-done.app/index.html')
  render(<AppsSection />)

  await userEvent.click(screen.getByRole('button', { name: 'half-done' }))

  expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([])
})

test('the section appears for an unfinished app alone, with no finished one', () => {
  withFiles('half-done.app/index.html')
  const { container } = render(<AppsSection />)
  expect(container.innerHTML).not.toBe('')
})

test('clicking one opens its tab', async () => {
  withApps('retro-board', 'burndown')
  render(<AppsSection />)
  await userEvent.click(screen.getByRole('button', { name: 'retro-board' }))
  expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([
    { kind: 'app', path: 'retro-board.app' },
  ])
})

test('a manifest and an entry document together register the app', () => {
  withFiles('retro-board.app/index.html', 'retro-board.app/app.yaml')
  expect(store.get(appPathsAtom)).toEqual(['retro-board.app'])
  expect(store.get(unregisteredAppPathsAtom)).toEqual([])
})

test('a manifest alone does not register — the manifest says finished, not exists', () => {
  withFiles('retro-board.app/app.yaml')
  expect(store.get(appPathsAtom)).toEqual([])
  expect(store.get(unregisteredAppPathsAtom)).toEqual([])
})

test('an entry document alone does not register, but is not forgotten either', () => {
  withFiles('retro-board.app/index.html', 'retro-board.app/app.js')
  expect(store.get(appPathsAtom)).toEqual([])
  expect(store.get(unregisteredAppPathsAtom)).toEqual(['retro-board.app'])
})

test('a nested manifest does not register a second app', () => {
  withFiles(
    'retro-board.app/index.html',
    'retro-board.app/app.yaml',
    'retro-board.app/sub.app/index.html',
    'retro-board.app/sub.app/app.yaml',
  )
  expect(store.get(appPathsAtom)).toEqual(['retro-board.app'])
})

test('a folder not named .app is not an app, whatever it holds', () => {
  withFiles('site/index.html', 'site/app.yaml', '.holi/apps/old/index.html')
  expect(store.get(appPathsAtom)).toEqual([])
  expect(store.get(unregisteredAppPathsAtom)).toEqual([])
})

test('an app on the agent surface is not one', () => {
  withFiles('.claude/x.app/index.html', '.claude/x.app/app.yaml')
  expect(store.get(appPathsAtom)).toEqual([])
})

test('the unregistered list is sorted and excludes the registered', () => {
  withFiles(
    'zeta.app/index.html',
    'alpha.app/index.html',
    'done.app/index.html',
    'done.app/app.yaml',
  )
  expect(store.get(appPathsAtom)).toEqual(['done.app'])
  expect(store.get(unregisteredAppPathsAtom)).toEqual(['alpha.app', 'zeta.app'])
})

/** The row labels, in render order: finished first, then unfinished. The
 *  section heading is a button too (it toggles the panel), so it is excluded by
 *  the `aria-expanded` it carries and the rows do not. */
function rowNames(): string[] {
  return screen
    .getAllByRole('button')
    .filter((b) => !b.hasAttribute('aria-expanded'))
    .map((b) => b.textContent ?? '')
}

test('renaming opens a field seeded with the current name, and Escape puts the row back', async () => {
  withApps('retro-board')
  render(<AppsSection />)

  await openMenuOn('retro-board')
  await userEvent.click(screen.getByText('Rename…'))

  const field = screen.getByLabelText<HTMLInputElement>('rename retro-board')
  expect(field.value).toBe('retro-board')

  await userEvent.keyboard('{Escape}')
  expect(screen.getByRole('button', { name: 'retro-board' })).toBeTruthy()
})

test('a name that cannot be one is reported under the field, and nothing is sent', async () => {
  withApps('retro-board')
  render(<AppsSection />)

  await openMenuOn('retro-board')
  await userEvent.click(screen.getByText('Rename…'))
  await userEvent.clear(screen.getByLabelText('rename retro-board'))
  await userEvent.type(screen.getByLabelText('rename retro-board'), 'a/b{Enter}')

  expect(await screen.findByText('a/b cannot name an app')).toBeTruthy()
  // Still a field, not a row: the refusal is something to fix, not to dismiss.
  expect(screen.queryByRole('button', { name: 'retro-board' })).toBeNull()
})

test('a name another app already holds is refused by name', async () => {
  withApps('retro-board', 'burndown')
  render(<AppsSection />)

  await openMenuOn('retro-board')
  await userEvent.click(screen.getByText('Rename…'))
  await userEvent.clear(screen.getByLabelText('rename retro-board'))
  await userEvent.type(screen.getByLabelText('rename retro-board'), 'burndown{Enter}')

  expect(await screen.findByText('burndown already exists')).toBeTruthy()
})

test('the menu offers to finish an unfinished app, and to open a finished one', async () => {
  withFiles('burndown.app/index.html', 'burndown.app/app.yaml', 'half-done.app/index.html')
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
    { kind: 'note', path: 'retro-board.app/index.html' },
  ])
})

test('Copy Path copies the bundle, not a file inside it', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  withApps('retro-board')
  render(<AppsSection />)

  await openMenuOn('retro-board')
  await userEvent.click(screen.getByText('Copy Path'))

  expect(writeText).toHaveBeenCalledWith('retro-board.app')
  vi.unstubAllGlobals()
})

/** Right-click a row and wait for its menu. */
async function openMenuOn(name: string): Promise<void> {
  await userEvent.pointer({
    target: screen.getByRole('button', { name }),
    keys: '[MouseRight]',
  })
  await screen.findByRole('menu')
}

test('hasApps is what Shell asks before it builds the panel at all', () => {
  // A collapsible panel cannot be conditional on its own contents: an empty one
  // still claims a slice of the column and still draws a handle above it.
  withApps()
  expect(store.get(hasAppsAtom)).toBe(false)

  withFiles('half-done.app/index.html')
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
