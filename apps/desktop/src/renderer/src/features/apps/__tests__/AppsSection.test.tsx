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
import { snapshotAtom } from '../../../state/vaults'
import { emptyWorkspace, workspaceAtom } from '../../../state/panes'

const store = getDefaultStore()

function withApps(...ids: string[]) {
  store.set(snapshotAtom, {
    docs: [],
    tasks: [],
    broken: [],
    dirs: [],
    files: ids.map((id) => ({ path: `.holi/apps/${id}/index.html`, updatedAt: '' })),
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
