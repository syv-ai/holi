/**
 * Every setting this vault has, in a tab (#16).
 *
 * The point of these is the three things a settings surface owes that a
 * one-shot ritual does not: it renders EVERY setting rather than the subset
 * worth asking a stranger at a vault's birth, it says which layer a value comes
 * from so a machine-local preference is never silently committed, and it writes
 * through the ritual's own procedure so the two cannot drift.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { VAULT_SETTING_DEFAULTS, VAULT_SETTING_DESCRIPTORS } from '@holi/shared'
import { SettingsView } from '../SettingsView'
import { activeRemoteAtom } from '@/state/vaults'

const read = vi.fn()
const write = vi.fn()
const themeRead = vi.fn()
const themeWrite = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    settings: {
      read: { query: () => read() },
      write: { mutate: (input: unknown) => write(input) },
    },
    // The tab renders the theme section too, so the mock has to answer for it —
    // otherwise every test here passes while logging an unhandled rejection.
    theme: {
      read: { query: () => themeRead() },
      write: { mutate: (input: unknown) => themeWrite(input) },
    },
  },
}))

const resolved = (over: Record<string, unknown> = {}) => ({
  ...VAULT_SETTING_DEFAULTS,
  warnings: [],
  ...over,
})

function setup(over: Record<string, unknown> = {}) {
  const store = createStore()
  store.set(activeRemoteAtom, 'git@github.com:syv-ai/vault.git')
  read.mockResolvedValue(resolved(over))
  write.mockResolvedValue({ ok: true, warnings: [] })
  themeRead.mockResolvedValue({ light: {}, dark: {}, warnings: [] })
  themeWrite.mockResolvedValue({ ok: true, warnings: [] })
  return render(
    <Provider store={store}>
      <SettingsView />
    </Provider>,
  )
}

beforeEach(() => {
  read.mockReset()
  write.mockReset()
  themeRead.mockReset()
  themeWrite.mockReset()
})

test('renders every setting, not just the ones the ritual asks about', async () => {
  setup()
  // Against the list, never a number: adding a setting is adding a descriptor.
  // This is the FULL list, which is the difference between this and the ritual —
  // `editorFont` has no birth question and still belongs here.
  await waitFor(() =>
    expect(screen.getAllByRole('group')).toHaveLength(VAULT_SETTING_DESCRIPTORS.length),
  )
  expect(screen.getAllByRole('group').map((r) => r.getAttribute('data-setting'))).toEqual(
    VAULT_SETTING_DESCRIPTORS.map((d) => d.key),
  )
})

test('says which layer each value comes from', async () => {
  setup()
  // Without this the pane can silently commit a machine-local preference, which
  // for appearance is exactly the failure the `.local` layer exists to prevent.
  const appearance = await screen.findByRole('group', { name: 'Appearance' })
  expect(await within(appearance).findByText('this machine')).toBeInTheDocument()
  const daily = await screen.findByRole('group', { name: 'Keep a daily note' })
  expect(within(daily).getByText('vault')).toBeInTheDocument()
})

test('writes a committed setting to the committed file, and a local one to the local file', async () => {
  setup()
  const daily = await screen.findByRole('group', { name: 'Keep a daily note' })
  await userEvent.click(within(daily).getByRole('checkbox'))
  await waitFor(() => expect(write).toHaveBeenCalled())
  expect(write.mock.calls[0]![0]).toMatchObject({
    committedJson: JSON.stringify({ dailyNotes: false }),
  })
  expect(write.mock.calls[0]![0]).not.toHaveProperty('localJson')

  const appearance = await screen.findByRole('group', { name: 'Appearance' })
  await userEvent.click(within(appearance).getByRole('radio', { name: 'Dark' }))
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
  expect(write.mock.calls[1]![0]).toMatchObject({
    localJson: JSON.stringify({ colorScheme: 'dark' }),
  })
  expect(write.mock.calls[1]![0]).not.toHaveProperty('committedJson')
})

test('re-reads after a write, so a control shows its own answer', async () => {
  setup()
  const daily = await screen.findByRole('group', { name: 'Keep a daily note' })
  await userEvent.click(within(daily).getByRole('checkbox'))
  // Twice: once on mount, once forced after the write. The atom caches per
  // vault, and a pane that could not see its own write would be a pane that
  // reports the value it had when you opened it.
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
})

test('shows the resolver’s complaint beside the setting it names', async () => {
  // Nothing displayed these at all before: a malformed value was replaced by a
  // default and never mentioned.
  setup({ warnings: ['dropped "dailyNotes": expected a boolean, got "yes"'] })
  const daily = await screen.findByRole('group', { name: 'Keep a daily note' })
  expect(within(daily).getByText(/expected a boolean/)).toBeInTheDocument()
})

test('says which settings wait for the next vault open', async () => {
  setup()
  const landing = await screen.findByRole('group', { name: 'Open on' })
  expect(within(landing).getByText(/next time this vault opens/)).toBeInTheDocument()
  // And only that one — everything else applies as you click it.
  expect(screen.getAllByText(/next time this vault opens/)).toHaveLength(1)
})

test('offers the files themselves', async () => {
  setup()
  expect(await screen.findByRole('button', { name: '.holi/settings/app.json' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '.holi/settings/app.local.json' })).toBeInTheDocument()
})
