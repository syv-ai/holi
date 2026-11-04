/**
 * Settings → Updates: a release's notes open formatted, the open vault's
 * skills say where they stand and update on request, Update skills
 * automatically is the vault's committed setting, and the account menu
 * offers the update while there is one, with a dot on the avatar.
 */
import { VAULT_SETTING_DEFAULTS, type ResolvedVaultSettings } from '@holi/shared'
import userEvent from '@testing-library/user-event'
import { createStore, Provider } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'

import { render, screen, waitFor, within } from '@/test/render'
import { AccountMenu } from '@/features/sidebar/account-menu'
import { SidebarProvider } from '@/components/ui/sidebar'
import { vaultSettingsAtom } from '@/state/settings'
import { watchPendingSkills } from '@/state/skills'
import { updateStatusAtom } from '@/state/updates'
import { activeRemoteAtom } from '@/state/vaults'

import { UpdatesPage } from '../pages/updates-page'

const run = vi.hoisted(() => vi.fn())
const write = vi.hoisted(() => vi.fn())
const notes = vi.hoisted(() => vi.fn())

vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: { run: { mutate: (input: unknown) => run(input) } },
    settings: {
      write: { mutate: (input: unknown) => write(input) },
      read: { query: () => Promise.resolve(SETTINGS) },
    },
    updates: { notes: { query: (input: unknown) => notes(input) } },
    app: {
      loginItem: { query: () => Promise.resolve({ openAtLogin: false }) },
    },
  },
}))

const SETTINGS: ResolvedVaultSettings = {
  ...VAULT_SETTING_DEFAULTS,
  warnings: [],
}

beforeEach(() => {
  run.mockReset()
  run.mockImplementation(async ({ name }: { name: string }) =>
    name === 'skills.status'
      ? {
          pending: ['.claude/skills/a/SKILL.md'],
          release: '0.5.0',
          autoUpdate: false,
        }
      : { summary: 'Updated 1 file.', changed: [], conflicts: null },
  )
  write.mockReset()
  write.mockResolvedValue({ ok: true, warnings: [] })
  notes.mockReset()
  notes.mockResolvedValue({
    kind: 'found',
    notes: {
      name: 'Holi 0.6.0',
      body: '## Fixes\n\n- Comments in documents',
      url: 'https://github.com/syv-ai/holi/releases/tag/v0.6.0',
    },
  })
  Object.assign(window, {
    holi: {
      ...(window as unknown as { holi?: object }).holi,
      vault: { onSkillsUpdated: () => () => undefined },
      openExternal: vi.fn(async () => undefined),
    },
  })
})

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(vaultSettingsAtom, { remote: 'syv/vault', settings: SETTINGS })
  store.set(updateStatusAtom, {
    channel: 'stable',
    supported: true,
    enabled: true,
    version: '0.5.0',
    state: 'ready',
    availableVersion: '0.6.0',
    percent: null,
    lastCheckAt: Date.now(),
    checkStartedAt: null,
    lastError: null,
  })
  watchPendingSkills(store)
  return store
}

test("a release's notes open formatted, from GitHub", async () => {
  const user = userEvent.setup()
  const store = setup()
  render(
    <Provider store={store}>
      <UpdatesPage />
    </Provider>,
  )
  expect(screen.getByText(/Last checked just now/)).toBeInTheDocument()
  const row = screen.getByText('What’s new in Holi 0.6.0').closest('[data-slot=field]')!
  await user.click(within(row as HTMLElement).getByRole('button', { name: 'Release notes' }))
  const dialog = await screen.findByRole('dialog')
  expect(await within(dialog).findByText('Fixes')).toBeInTheDocument()
  expect(within(dialog).getByText('Comments in documents')).toBeInTheDocument()
  expect(notes).toHaveBeenCalledWith({ version: '0.6.0' })
})

test("the vault's skills update on request, and Update skills automatically is committed", async () => {
  const user = userEvent.setup()
  const store = setup()
  render(
    <Provider store={store}>
      <UpdatesPage />
    </Provider>,
  )
  expect(await screen.findByText(/has 1 newer file for this vault/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Update skills' }))
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: 'skills.update' })),
  )
  await user.click(screen.getByRole('switch', { name: 'Update skills automatically' }))
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        committedJson: JSON.stringify({ autoUpdateSkills: true }),
      }),
    ),
  )
})

test('the account menu offers the update, with a dot on the avatar', async () => {
  const user = userEvent.setup()
  const store = setup()
  render(
    <Provider store={store}>
      <SidebarProvider>
        <AccountMenu />
      </SidebarProvider>
    </Provider>,
  )
  const trigger = await screen.findByRole('button', {
    name: 'Open account menu, an update to look at',
  })
  expect(document.querySelector('[data-update-dot]')).not.toBeNull()
  await user.click(trigger)
  expect(await screen.findByRole('menuitem', { name: /Restart to update/ })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: /Update skills/ })).toBeInTheDocument()
  await user.click(screen.getByRole('menuitem', { name: 'Not now' }))
  await user.click(trigger)
  expect(await screen.findByRole('menuitem', { name: /Restart to update/ })).toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: /Update skills/ })).toBeNull()
})
