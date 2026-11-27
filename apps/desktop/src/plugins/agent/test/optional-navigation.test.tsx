import { Provider, createStore } from 'jotai'
import { beforeEach, expect, it, vi } from 'vitest'
import { emptyVaultSnapshot, resolveAppSettings, type ResolvedVaultSettings } from '@holi/shared'
import { act, render, screen, waitFor } from '@/test/render'
import { SidebarProvider } from '@/components/ui/sidebar'
import { activeRemoteAtom, loadVaultSettingsAtom, snapshotAtom } from '@/plugin-api'
import { AgentsNavigation, AgentsSidebar } from '../renderer/agents/agents-sidebar'
import { AgentsView } from '../renderer/agents/agents-view'

const transport = vi.hoisted(() => ({ settings: vi.fn(), note: vi.fn() }))
vi.mock('@/lib/trpc', () => ({
  trpc: {
    settings: { read: { query: transport.settings } },
    notes: { read: { query: transport.note } },
  },
}))

function settings(enabled: boolean): ResolvedVaultSettings {
  return {
    ...resolveAppSettings(
      JSON.stringify({ agentInbox: enabled, agentHistory: enabled, agentMemory: enabled }),
      null,
    ),
    plugins: { vault: {}, localOff: [] },
    pluginValues: {},
  }
}

async function setup(enabled: boolean) {
  const store = createStore()
  store.set(activeRemoteAtom, 'fixture/navigation')
  transport.settings.mockResolvedValue(settings(enabled))
  await store.set(loadVaultSettingsAtom)
  return store
}

beforeEach(() => {
  transport.settings.mockReset()
  transport.note
    .mockReset()
    .mockResolvedValue(
      '---\ntype: project\ndescription: A retained fact\n---\n\nA retained fact.\n',
    )
})

it('hides disabled optional navigation while retaining Sessions', async () => {
  const store = await setup(false)
  render(
    <Provider store={store}>
      <SidebarProvider>
        <AgentsNavigation />
        <AgentsSidebar />
      </SidebarProvider>
    </Provider>,
  )
  expect(screen.queryByRole('button', { name: 'Inbox' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Memory' })).not.toBeInTheDocument()
  expect(screen.getByText('Sessions', { exact: true })).toBeInTheDocument()
})

it('does not read a restored disabled Memory view and resumes reading when re-enabled', async () => {
  const store = await setup(false)
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    docs: [{ path: '.holi/memory/fact.md', kind: 'note', updatedAt: '2026-11-25T12:00:00Z' }],
  })
  render(
    <Provider store={store}>
      <AgentsView selection={{ owner: 'agent', id: 'memory' }} />
    </Provider>,
  )
  expect(screen.getByText('Memory is off')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Open Settings' })).toBeInTheDocument()
  expect(transport.note).not.toHaveBeenCalled()
  transport.settings.mockResolvedValue(settings(true))
  await act(async () => {
    await store.set(loadVaultSettingsAtom, { force: true })
  })
  await waitFor(() =>
    expect(transport.note).toHaveBeenCalledWith({
      remote: 'fixture/navigation',
      path: '.holi/memory/fact.md',
    }),
  )
  expect(screen.queryByText('Memory is off')).not.toBeInTheDocument()
})
