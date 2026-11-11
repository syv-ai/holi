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
import { fireEvent, render, screen, waitFor } from '@/test/render'
import { coreContributionAtom } from '@/state/plugins'
import { vaultSettingsAtom } from '@/state/settings'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { focusedTab } from '@/state/shell-workspace'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'
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
