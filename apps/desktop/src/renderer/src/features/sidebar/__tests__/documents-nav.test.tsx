import { Provider, createStore } from 'jotai'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Task } from '@holi/shared'
import { DEFAULT_STATUSES, emptyVaultSnapshot } from '@holi/shared'
import { render, screen, waitFor } from '@/test/render'
import { nowAtom } from '@/state/clock'
import { recordStatusesReadAtom } from '@/state/planning'
import {
  activeRemoteAtom,
  activeRemoteRevisionValueAtom,
  openedRemoteAtom,
  snapshotAtom,
} from '@/state/vaults'
import { SidebarProvider } from '@/components/ui/sidebar'
import { BOARD_KEY } from '@/state/tab-descriptor'
import { AppSidebar } from '../app-sidebar'
import { DocumentsNav } from '../documents-nav'

const drag = vi.hoisted(() => vi.fn(() => ({ 'data-testid': 'board-drag-binding' })))
vi.mock('@/features/shell/use-tab-drag', () => ({ useTabDrag: () => drag }))
vi.mock('../account-menu', () => ({ AccountMenu: () => null }))
vi.mock('../sidebar-apps', () => ({
  SidebarAppItem: () => null,
  useSidebarApps: () => [],
}))
vi.mock('../vault-switcher', () => ({ VaultSwitcher: () => null }))
vi.mock('../files-section', () => ({ FilesSection: () => null }))
vi.mock('@/composites/brand-mark', () => ({ BrandMark: () => null }))

const task = (path: string, due?: string, status = 'todo') =>
  ({ path, title: path, due, status }) as Task

function setup(tasks: Task[] | null = []) {
  const store = createStore()
  store.set(activeRemoteAtom, 'owner/vault')
  store.set(openedRemoteAtom, tasks === null ? null : 'owner/vault')
  store.set(recordStatusesReadAtom, {
    remote: 'owner/vault',
    revision: store.get(activeRemoteRevisionValueAtom),
    stamp: null,
    retry: 0,
    file: { state: 'ready', value: [...DEFAULT_STATUSES], warnings: [] },
  })
  store.set(nowAtom, '2026-11-12T10:30')
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    claimed: tasks === null ? {} : { tasks: { items: tasks, broken: [] } },
  })
  const onOpen = vi.fn()
  const onOpenSearch = vi.fn()
  const nav = (activeId: string | null = null) => (
    <Provider store={store}>
      <SidebarProvider>
        <DocumentsNav activeId={activeId} onOpen={onOpen} onOpenSearch={onOpenSearch} />
      </SidebarProvider>
    </Provider>
  )
  const appSidebar = (collapsed: boolean, activeId: string | null = null) => (
    <Provider store={store}>
      <SidebarProvider>
        <AppSidebar
          activeId={activeId}
          collapsed={collapsed}
          onOpen={onOpen}
          onMoved={() => undefined}
          onNewDocument={() => undefined}
          onAddVault={() => undefined}
          onToggle={() => undefined}
          onOpenSearch={onOpenSearch}
          activeApp={null}
          onOpenApp={() => undefined}
        />
      </SidebarProvider>
    </Provider>
  )
  return { store, onOpen, onOpenSearch, nav, appSidebar }
}

beforeEach(() => drag.mockClear())

test('expanded Board shows due breakdown, retains open count with no due tasks, and has a visible tooltip', async () => {
  const { nav } = setup([
    task('projects/task.late.md', '2026-11-11'),
    task('projects/task.today.md', '2026-11-12'),
    task('projects/task.no-date.md'),
  ])
  const user = userEvent.setup()
  render(nav())
  const board = screen.getByRole('button', {
    name: 'Board, 1 overdue, 1 due today, 3 open tasks',
  })
  expect(board).toHaveAttribute('data-testid', 'board-drag-binding')
  expect(screen.getByText('2 due')).toBeInTheDocument()
  await user.hover(board)
  expect(await screen.findByRole('tooltip')).toHaveTextContent(
    'Board, 1 overdue, 1 due today, 3 open tasks',
  )

  const { nav: noDueNav } = setup([task('projects/task.open.md')])
  render(noDueNav())
  expect(screen.getByRole('button', { name: 'Board, 1 open tasks' })).toBeInTheDocument()
  expect(
    screen.getByText('1', { selector: '[data-slot="sidebar-menu-badge"]' }),
  ).toBeInTheDocument()
})

test('empty/loading states have no count; active Board remains keyboard-operable', async () => {
  const { nav, onOpen } = setup([])
  const user = userEvent.setup()
  const view = render(nav(BOARD_KEY))
  const board = screen.getByRole('button', { name: 'Board, 0 open tasks' })
  expect(board).toHaveAttribute('aria-current', 'page')
  expect(document.querySelector('[data-slot="sidebar-menu-badge"]')).not.toBeInTheDocument()
  await user.tab()
  while (document.activeElement !== board) await user.tab()
  await user.keyboard('{Enter}')
  expect(onOpen).toHaveBeenCalledWith(BOARD_KEY)
  view.unmount()

  const { nav: loadingNav } = setup(null)
  render(loadingNav())
  expect(screen.getByRole('button', { name: 'Board, 0 open tasks' })).toBeInTheDocument()
  expect(document.querySelector('[data-slot="sidebar-menu-badge"]')).not.toBeInTheDocument()
})

test('Board badge stays hidden until the displayed vault statuses settle', async () => {
  const { store, nav } = setup([task('projects/task.open.md')])
  store.set(recordStatusesReadAtom, {
    remote: 'owner/vault',
    revision: store.get(activeRemoteRevisionValueAtom) - 1,
    stamp: null,
    retry: 0,
    file: { state: 'ready', value: [...DEFAULT_STATUSES], warnings: [] },
  })
  render(nav())
  expect(screen.getByRole('button', { name: 'Board, 0 open tasks' })).toBeInTheDocument()
  expect(document.querySelector('[data-slot="sidebar-menu-badge"]')).not.toBeInTheDocument()

  store.set(recordStatusesReadAtom, {
    remote: 'owner/vault',
    revision: store.get(activeRemoteRevisionValueAtom),
    stamp: null,
    retry: 0,
    file: { state: 'ready', value: [...DEFAULT_STATUSES], warnings: [] },
  })
  expect(await screen.findByRole('button', { name: 'Board, 1 open tasks' })).toBeInTheDocument()
})

test('live snapshot changes update counts and collapsed rail shows only numeric due attention', async () => {
  const { store, nav, appSidebar, onOpen } = setup([task('projects/task.open.md')])
  const user = userEvent.setup()
  const view = render(nav())
  expect(
    screen.getByText('1', { selector: '[data-slot="sidebar-menu-badge"]' }),
  ).toBeInTheDocument()
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    claimed: {
      tasks: {
        items: [task('projects/task.open.md'), task('projects/task.due.md', '2026-11-12')],
        broken: [],
      },
    },
  })
  await waitFor(() => expect(screen.getByText('1 due')).toBeInTheDocument())
  expect(
    screen.getByRole('button', { name: 'Board, 0 overdue, 1 due today, 2 open tasks' }),
  ).toBeInTheDocument()
  view.unmount()

  render(appSidebar(true, BOARD_KEY))
  const board = screen.getByRole('button', { name: 'Board, 0 overdue, 1 due today, 2 open tasks' })
  expect(board).toHaveAttribute('aria-current', 'page')
  expect(
    screen.getByText('1', { selector: '[data-slot="sidebar-menu-badge"]' }),
  ).toBeInTheDocument()
  expect(
    screen.queryByText('2', { selector: '[data-slot="sidebar-menu-badge"]' }),
  ).not.toBeInTheDocument()
  await user.hover(board)
  expect(await screen.findByRole('tooltip')).toHaveTextContent('1 due today')
  await user.click(board)
  expect(onOpen).toHaveBeenCalledWith(BOARD_KEY)
})
