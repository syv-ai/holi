/**
 * A folder document a New item made, named in place in the Files tree, opens
 * as its own surface at the new name, through the shell's own open: the
 * shell resolves the path from the snapshot as it is when it opens, not as it
 * was at its last render.
 */
import { Provider, createStore } from 'jotai'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import {
  VAULT_SETTING_DEFAULTS,
  emptyVaultSnapshot,
  type ResolvedVaultSettings,
} from '@holi/shared'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import { coreContributionAtom } from '@/state/plugins'
import { vaultSettingsAtom } from '@/state/settings'
import { openTabAtom, shellWorkspaceAtom } from '@/state/shell-tabs'
import { emptyWorkspace, focusedTab } from '@/state/shell-workspace'
import {
  activeRemoteAtom,
  openedRemoteAtom,
  snapshotAtom,
  vaultsAtom,
  vaultNavigationKeyAtom,
} from '@/state/vaults'
import { revealInFilesAtom } from '@/state/reveal-in-files'
import type { Move } from '@/lib/tree-actions'

const SETTINGS: ResolvedVaultSettings = { ...VAULT_SETTING_DEFAULTS, warnings: [] }

const vault = vi.hoisted(() => ({
  store: null as unknown as ReturnType<typeof createStore>,
}))

// The vault's own procedures act on the store's snapshot; anything else the
// shell asks answers nothing.
vi.mock('@/lib/trpc', () => {
  const snapshot = async () => vault.store.get((await import('@/state/vaults')).snapshotAtom)
  const move = async ({ moves }: { moves: { from: string; to: string }[] }) => {
    const { snapshotAtom: at } = await import('@/state/vaults')
    const to = new Map(moves.map((m) => [m.from, m.to]))
    const s = vault.store.get(at)
    vault.store.set(at, {
      ...s,
      files: s.files.map((f) => ({ ...f, path: to.get(f.path) ?? f.path })),
    })
    return { rewritten: [] }
  }
  const answer = (name: string): unknown =>
    name === 'settings.read'
      ? SETTINGS
      : name === 'settings.pluginFailures'
        ? {}
        : name === 'github.collaborators'
          ? { visibility: 'private', collaborators: [] }
          : name === 'subscriptions.list'
            ? []
            : null
  const procedure = (name: string) => ({
    query: name === 'vaults.snapshot' ? snapshot : async () => answer(name),
    mutate: name === 'notes.move' ? move : async () => ({ ok: true }),
    subscribe: () => ({ unsubscribe() {} }),
  })
  const router = (routerName: string) =>
    new Proxy(
      {},
      {
        get: (_t, key) => (typeof key === 'string' ? procedure(`${routerName}.${key}`) : undefined),
      },
    )
  const trpc = new Proxy(
    {},
    { get: (_t, key) => (typeof key === 'string' ? router(key) : undefined) },
  )
  return { trpc }
})

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))
vi.mock('@/components/ui/motion-panels', () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelSeparator: () => <div role="separator" />,
}))
vi.mock('motion-panels/react', () => ({
  Separator: () => <div role="separator" />,
}))

// The sidebar is the Files tree alone, given the shell's own open and move.
vi.mock('@/features/sidebar/app-sidebar', async () => {
  const { FilesSection } = await import('@/features/sidebar/files-section')
  return {
    AppSidebar: ({
      collapsed,
      activeId,
      onOpen,
      onMoved,
    }: {
      collapsed?: boolean
      activeId: string | null
      onOpen: (id: string) => void
      onMoved: (moves: Move[]) => void
    }) =>
      collapsed ? null : <FilesSection activeId={activeId} onOpen={onOpen} onMoved={onMoved} />,
  }
})

const { AppShell } = await import('@/features/shell/app-shell')

test('a made meeting named in place opens as the meeting at its new name', async () => {
  const store = createStore()
  vault.store = store
  store.set(activeRemoteAtom, 'mara/notes')
  store.set(openedRemoteAtom, 'mara/notes')
  store.set(vaultsAtom, [
    { remote: 'mara/notes', path: '/v', name: 'notes', lastOpenedAt: '2026-10-23T10:00:00.000Z' },
  ] as never)
  store.set(snapshotAtom, { ...emptyVaultSnapshot(), dirs: ['kunder'] })
  store.set(vaultSettingsAtom, { remote: 'mara/notes', settings: SETTINGS })
  const run = vi.fn(async ({ parent, name }: { parent: string; name: string }) => {
    const path = `${parent}/${name}.meeting/transcript.local.md`
    const s = store.get(snapshotAtom)
    store.set(snapshotAtom, {
      ...s,
      files: [...s.files, { path, updatedAt: '2026-10-23T10:00:00Z' }],
    })
    return path
  })
  store.set(coreContributionAtom, {
    surfaces: [{ kind: 'meetings', label: 'Meetings', icon: () => null, render: () => null }],
    rail: [],
    claims: [
      {
        match: (p: string) => p.endsWith('.meeting'),
        folder: { surface: 'meetings', entry: 'transcript.local.md' },
        create: {
          id: 'meeting',
          label: 'New meeting',
          icon: () => null,
          placeholder: 'Meeting title',
          run,
        },
      },
    ],
  } as never)
  render(
    <Provider store={store}>
      <AppShell onAddVault={() => {}} />
    </Provider>,
  )

  fireEvent.contextMenu(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New meeting' }))
  await screen.findByLabelText('Rename Untitled.meeting')
  await waitFor(() =>
    expect(focusedTab(store.get(shellWorkspaceAtom))).toBe(
      'holi:surface:meetings:kunder/Untitled.meeting',
    ),
  )
  await userEvent.keyboard('Weekly{Enter}')
  await waitFor(() =>
    expect(focusedTab(store.get(shellWorkspaceAtom))).toBe(
      'holi:surface:meetings:kunder/Weekly.meeting',
    ),
  )
  expect(focusedTab(store.get(shellWorkspaceAtom))).not.toBe('kunder/Weekly.meeting')
})

function directoryShell() {
  const store = createStore()
  vault.store = store
  store.set(activeRemoteAtom, 'mara/notes')
  store.set(openedRemoteAtom, 'mara/notes')
  store.set(vaultsAtom, [
    { remote: 'mara/notes', path: '/v', name: 'notes', lastOpenedAt: '2026-10-23T10:00:00.000Z' },
  ] as never)
  store.set(snapshotAtom, { ...emptyVaultSnapshot(), dirs: ['kunder'] })
  store.set(vaultSettingsAtom, { remote: 'mara/notes', settings: SETTINGS })
  store.set(coreContributionAtom, {
    surfaces: [
      {
        kind: 'preview',
        label: 'Preview',
        icon: () => null,
        render: () => <section aria-label="Existing preview">Retained content</section>,
      },
    ],
    rail: [],
    claims: [],
  } as never)
  store.set(shellWorkspaceAtom, emptyWorkspace())
  store.set(openTabAtom, { kind: 'surface', surface: 'preview' })
  store.set(openTabAtom, { kind: 'settings' })
  render(
    <Provider store={store}>
      <AppShell onAddVault={() => {}} />
    </Provider>,
  )
  return store
}

test('a directory link from Settings exposes Files without replacing Settings or its tabs', async () => {
  const store = directoryShell()
  await screen.findByRole('navigation', { name: 'Settings' })
  const workspace = store.get(shellWorkspaceAtom)
  const settingsPane = document.querySelector('[data-pane="holi:settings"]')!
  expect(settingsPane).toBeVisible()
  act(() =>
    store.set(revealInFilesAtom, {
      path: 'kunder',
      directory: true,
      remote: 'mara/notes',
      navigation: store.get(vaultNavigationKeyAtom),
    }),
  )
  const row = await screen.findByRole('treeitem', { name: 'kunder' })
  await waitFor(() => expect(row).toHaveFocus())
  expect(row).toHaveAttribute('aria-expanded', 'true')
  expect(row).toHaveAttribute('aria-selected', 'true')
  expect(settingsPane).toBeVisible()
  expect(store.get(shellWorkspaceAtom)).toEqual(workspace)
})

test('an ordinary strip-tab click retires a directory awaiting its snapshot', async () => {
  const store = directoryShell()
  act(() =>
    store.set(revealInFilesAtom, {
      path: 'later',
      directory: true,
      remote: 'mara/notes',
      navigation: store.get(vaultNavigationKeyAtom),
    }),
  )
  await screen.findByRole('tree')
  await userEvent.click(await screen.findByRole('tab', { name: 'Preview' }))
  expect(await screen.findByRole('region', { name: 'Existing preview' })).toBeVisible()
  act(() => store.set(snapshotAtom, { ...store.get(snapshotAtom), dirs: ['kunder', 'later'] }))
  const row = await screen.findByRole('treeitem', { name: 'later' })
  expect(row).toHaveAttribute('aria-expanded', 'false')
  expect(row).toHaveAttribute('aria-selected', 'false')
  expect(row).not.toHaveFocus()
  expect(focusedTab(store.get(shellWorkspaceAtom))).toBe('holi:surface:preview')
})
