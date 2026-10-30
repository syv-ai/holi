/**
 * Settings in the shell: ⌘, brings it forward with its nav in the sidebar's
 * place, a plugin's "Open Connections" lands on that page, a setting writes
 * through `settings.write`, closing the tab gives the files back, and an
 * agent's Edit opens on that agent.
 */
import { Provider, createStore } from 'jotai'
import { act } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  VAULT_SETTING_DEFAULTS,
  emptyVaultSnapshot,
  type ResolvedVaultSettings,
} from '@holi/shared'

import { fireEvent, render, screen, waitFor, within } from '@/test/render'
import type { RendererPlugin } from '@/plugin-api/types'
import { installedPluginsAtom } from '@/state/plugins'
import { openSettingsSectionAtom } from '@/state/settings-section'
import { vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'

const write = vi.fn(async (_input: unknown) => ({
  ok: true as const,
  warnings: [] as string[],
}))

const SETTINGS: ResolvedVaultSettings = {
  ...VAULT_SETTING_DEFAULTS,
  warnings: [],
}

/** This machine's agents, as `agent.harnesses` lists them. */
const AGENTS = {
  agents: [
    {
      harness: {
        id: 'claude',
        label: 'Claude Code',
        integration: 'claude',
        command: { bin: 'claude', args: [] },
      },
      builtIn: true,
      edited: false,
      path: '/usr/local/bin/claude',
      unattended: null,
    },
    {
      harness: {
        id: 'aider',
        label: 'Aider',
        command: { bin: 'aider', args: ['--no-auto-commits'] },
      },
      builtIn: false,
      edited: false,
      path: '/usr/local/bin/aider',
      unattended: 'Aider runs only in a terminal you watch.',
    },
  ],
  file: '/data/agent-harnesses.json',
  ignored: 0,
  unreadable: null,
}

const capRun = vi.fn(async (input: { name: string }) =>
  input.name === 'agent.harnesses' ? AGENTS : { ok: true },
)

// Every other call the shell makes answers nothing, and never rejects. Two
// levels deep, `trpc.<router>.<procedure>`, and nothing for a symbol, so
// nothing walking the mock can recurse forever.
vi.mock('@/lib/trpc', () => {
  const answer = (name: string): unknown =>
    name === 'settings.read'
      ? SETTINGS
      : name === 'settings.pluginFailures'
        ? {}
        : name === 'github.collaborators'
          ? { visibility: 'private', collaborators: [] }
          : name === 'github.repoSize'
            ? { sizeKb: 7 * 1024 * 1024 }
            : null
  const procedure = (name: string) => ({
    query: async () => answer(name),
    mutate:
      name === 'settings.write' ? write : name === 'cap.run' ? capRun : async () => ({ ok: true }),
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

// jsdom lays nothing out, and the resizable panels answer a zero width with
// a resize, forever: plain boxes stand in for them.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))

// The files sidebar's tree does not settle in jsdom; what matters here is
// only whether it or Settings' nav holds the sidebar.
vi.mock('@/features/sidebar/app-sidebar', () => ({
  AppSidebar: ({ collapsed }: { collapsed?: boolean }) =>
    collapsed ? <div>Rail</div> : <div>Documents</div>,
}))

const { AppShell } = await import('@/features/shell/app-shell')

/** A plugin with a settings page of its own, as Google's Connections is. */
const CONNECTIONS: RendererPlugin = {
  info: { id: 'google', label: 'Google', default: true },
  settingsSections: [
    {
      id: 'connections',
      label: 'Connections',
      headings: [],
      files: [],
      Component: () => <p>Connect a Google account</p>,
    },
  ],
}

function mount() {
  const store = createStore()
  store.set(activeRemoteAtom, 'mara/notes')
  store.set(vaultsAtom, [
    {
      remote: 'mara/notes',
      path: '/vaults/mara/notes',
      name: 'notes',
      lastOpenedAt: '2026-10-23T10:00:00.000Z',
    },
  ] as never)
  store.set(snapshotAtom, emptyVaultSnapshot())
  store.set(installedPluginsAtom, [CONNECTIONS])
  store.set(vaultSettingsAtom, { remote: 'mara/notes', settings: SETTINGS })
  render(
    <Provider store={store}>
      <AppShell onAddVault={() => {}} />
    </Provider>,
  )
  return store
}

beforeEach(() => {
  write.mockClear()
  capRun.mockClear()
})

test('⌘, opens Settings as a tab, its nav in place of the files', async () => {
  mount()
  expect(screen.queryByRole('tab', { name: /Settings/ })).toBeNull()
  fireEvent.keyDown(window, { key: ',', metaKey: true })
  expect(await screen.findByRole('tab', { name: /Settings/ })).toBeTruthy()
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  expect(within(nav).getByText('Vault')).toBeTruthy()
  expect(screen.getByRole('heading', { level: 1, name: 'General' })).toBeTruthy()
  expect(screen.queryByText('Documents')).toBeNull()
})

test('Ctrl+, opens it too', async () => {
  mount()
  fireEvent.keyDown(window, { key: ',', ctrlKey: true })
  expect(await screen.findByRole('tab', { name: /Settings/ })).toBeTruthy()
})

test("Open Connections lands on the plugin's own page", async () => {
  const store = mount()
  act(() => store.set(openSettingsSectionAtom, 'connections'))
  expect(await screen.findByRole('heading', { level: 1, name: 'Connections' })).toBeTruthy()
  expect(screen.getByText('Connect a Google account')).toBeTruthy()
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  expect(within(nav).getByRole('button', { name: 'Connections' })).toHaveAttribute(
    'aria-current',
    'page',
  )
})

test('a setting writes through settings.write, to the file it lives in', async () => {
  const store = mount()
  act(() => store.set(openSettingsSectionAtom, 'editor'))
  const daily = await screen.findByRole('switch', {
    name: 'Keep a daily note',
  })
  fireEvent.click(daily)
  await waitFor(() => expect(write).toHaveBeenCalled())
  expect(write.mock.calls[0]![0]).toEqual({
    remote: 'mara/notes',
    committedJson: JSON.stringify({ dailyNotes: false }),
  })

  write.mockClear()
  fireEvent.click(screen.getByRole('switch', { name: 'Space asks the agent' }))
  await waitFor(() => expect(write).toHaveBeenCalled())
  expect(write.mock.calls[0]![0]).toEqual({
    remote: 'mara/notes',
    localJson: JSON.stringify({ spaceAsksAgent: false }),
  })
})

test('closing the Settings tab gives the files back', async () => {
  mount()
  fireEvent.keyDown(window, { key: ',', metaKey: true })
  await screen.findByRole('tab', { name: /Settings/ })
  fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }))
  await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull())
  expect(screen.getByText('Documents')).toBeTruthy()
})

test('every page in the nav opens to its own heading', async () => {
  mount()
  fireEvent.keyDown(window, { key: ',', metaKey: true })
  const nav = await screen.findByRole('navigation', { name: 'Settings' })
  const rows = within(nav)
    .getAllByRole('button')
    .filter((row) => row.textContent !== 'Back')
  expect(rows.map((row) => row.textContent)).toEqual([
    'General',
    'Members',
    'Editor',
    'Commits',
    'Plugins',
    'Connections',
    'Appearance',
    'Updates',
    'GitHub',
  ])
  for (const row of rows) {
    fireEvent.click(row)
    expect(await screen.findByRole('heading', { level: 1, name: row.textContent! })).toBeTruthy()
  }
})

test('General says what the repo weighs on GitHub, against what GitHub recommends', async () => {
  mount()
  fireEvent.keyDown(window, { key: ',', metaKey: true })
  expect(await screen.findByText('7.0 GB')).toBeTruthy()
  expect(screen.getByText('70%')).toBeTruthy()
  expect(
    screen.getByRole('progressbar', {
      name: "Share of GitHub's recommended size",
    }),
  ).toBeTruthy()
})

test("an agent's Edit opens on that agent, every time, and saves it", async () => {
  mount()
  fireEvent.keyDown(window, { key: ',', metaKey: true })
  const editOf = async (label: string): Promise<HTMLElement> => {
    const more = await screen.findByRole('button', { name: `More for ${label}` })
    fireEvent.keyDown(more, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }))
    return screen.findByRole('dialog', { name: `Edit ${label}` })
  }

  const claude = await editOf('Claude Code')
  expect(within(claude).getByLabelText('Program')).toHaveValue('claude')
  // Claude Code's supervisor reads neither, so neither is offered.
  expect(within(claude).queryByLabelText('Arguments')).toBeNull()
  expect(within(claude).queryByLabelText('Environment')).toBeNull()
  fireEvent.click(within(claude).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  const aider = await editOf('Aider')
  expect(within(aider).getByLabelText('Program')).toHaveValue('aider')
  expect(within(aider).getByLabelText('Arguments')).toHaveValue('--no-auto-commits')
  fireEvent.click(within(aider).getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(capRun.mock.calls.some(([c]) => c.name === 'agent.harnessSave')).toBe(true),
  )
  const saved = capRun.mock.calls.find(([c]) => c.name === 'agent.harnessSave')![0] as unknown as {
    paramsJson: string
  }
  expect(JSON.parse(saved.paramsJson)).toMatchObject({ harness: { id: 'aider' }, create: false })
})
