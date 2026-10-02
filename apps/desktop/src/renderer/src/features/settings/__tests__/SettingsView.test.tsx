/**
 * Every setting this vault has, in a tab with a rail.
 *
 * Unlike the onboarding ritual it renders EVERY setting, says which layer a
 * value comes from so a machine-local preference is never silently committed,
 * and writes through the ritual's own procedure so the two cannot drift.
 *
 * The rail adds two silent failures, both pinned here: a descriptor filed under
 * a section that does not exist renders NOWHERE, and a declared heading the
 * section never renders is a jump that scrolls to nothing.
 */
import { fireEvent, render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { VAULT_SETTING_DEFAULTS, VAULT_SETTING_DESCRIPTORS } from '@holi/shared'
import { SettingsView } from '../SettingsView'
import { CORE_SETTINGS_SECTIONS } from '../sections'
import { descriptorsIn } from '../DescriptorSection'
import { activeRemoteAtom } from '@/state/vaults'
import { installedPluginsAtom } from '@/state/plugins'

const read = vi.fn()
const write = vi.fn()
const themeRead = vi.fn()
const themeWrite = vi.fn()
const collaborators = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    settings: {
      read: { query: () => read() },
      write: { mutate: (input: unknown) => write(input) },
    },
    // The Appearance section renders the theme too, so the mock has to answer
    // for it, otherwise every test here passes while logging an unhandled
    // rejection.
    theme: {
      read: { query: () => themeRead() },
      holi: { query: () => Promise.resolve({ light: {}, dark: {} }) },
      write: { mutate: (input: unknown) => themeWrite(input) },
      reset: { mutate: vi.fn() },
    },
    // The tests below walk EVERY section, so this mock has to answer for the
    // Vault and Account sections too, only so the walk does not
    // throw.
    github: {
      collaborators: { query: () => collaborators() },
      openCollaboratorSettings: { mutate: vi.fn() },
    },
    vaults: {
      unpushed: { query: async () => [] },
      membership: { query: async () => ({ kind: 'gone' }) },
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
  store.set(activeRemoteAtom, 'syv-ai/vault')
  // A test-only plugin, so the plugins row has a switch to render.
  store.set(installedPluginsAtom, [{ info: { id: 'fake', label: 'Fake', default: true } }])
  read.mockResolvedValue(resolved(over))
  write.mockResolvedValue({ ok: true, warnings: [] })
  themeRead.mockResolvedValue({ light: {}, dark: {}, warnings: [] })
  themeWrite.mockResolvedValue({ ok: true, warnings: [] })
  collaborators.mockResolvedValue({ visibility: 'private', collaborators: [] })
  return render(
    <Provider store={store}>
      <SettingsView />
    </Provider>,
  )
}

/** Click a rail entry, and wait for its section to be the one on screen. */
async function go(label: string): Promise<void> {
  // `find`, not `get`: the tab shows a placeholder until the first settings read
  // lands, so the very first `go` of a test can arrive before the rail exists.
  const rail = await screen.findByRole('navigation', { name: 'Settings sections' })
  await userEvent.click(within(rail).getByRole('button', { name: label }))
  await waitFor(() => expect(screen.getByRole('heading', { name: label })).toBeInTheDocument())
}

beforeEach(() => {
  read.mockReset()
  write.mockReset()
  themeRead.mockReset()
  themeWrite.mockReset()
  collaborators.mockReset()
})

test('every descriptor is filed under a section that exists', () => {
  // The check a union type would have given for free, in the layer that owns
  // the list: `@holi/shared` cannot import the registry, so `section` is a
  // plain string there and a typo would render the setting nowhere at all.
  const ids = new Set(CORE_SETTINGS_SECTIONS.map((s) => s.id))
  for (const descriptor of VAULT_SETTING_DESCRIPTORS) {
    expect(ids, `${descriptor.key} is filed under "${descriptor.section}"`).toContain(
      descriptor.section,
    )
  }
})

test('every setting renders, across the sections', async () => {
  setup()
  // Against the list, never a number. This is the FULL list, unlike the
  // ritual: `editorFont` has no birth question and still belongs here.
  const seen: string[] = []
  for (const section of CORE_SETTINGS_SECTIONS) {
    await go(section.label)
    // The rail's tree has groups of its own.
    const rail = screen.getByRole('navigation', { name: 'Settings sections' })
    const rows = screen.queryAllByRole('group').filter((r) => !rail.contains(r))
    expect(rows.map((r) => r.getAttribute('data-setting'))).toEqual(
      descriptorsIn(VAULT_SETTING_DESCRIPTORS, section.id).map((d) => d.key),
    )
    seen.push(...descriptorsIn(VAULT_SETTING_DESCRIPTORS, section.id).map((d) => d.key))
  }
  expect(new Set(seen)).toEqual(new Set(VAULT_SETTING_DESCRIPTORS.map((d) => d.key)))
})

test('every heading the rail offers is a heading the section renders', async () => {
  // The rail scrolls by `[data-heading]`, so a declared heading the section
  // never renders is a link that silently scrolls nowhere.
  setup()
  for (const section of CORE_SETTINGS_SECTIONS) {
    if (section.headings.length === 0) continue
    await go(section.label)
    for (const heading of section.headings) {
      await waitFor(() =>
        expect(
          document.querySelector(`[data-heading="${heading.id}"]`),
          `${section.id} renders "${heading.title}"`,
        ).not.toBeNull(),
      )
    }
  }
})

test('a section shows its own rows and nobody else’s', async () => {
  setup()
  // General is where the tab opens, so the daily-note row is there and the
  // commit transforms are not.
  expect(await screen.findByRole('group', { name: 'Keep a daily note' })).toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'Largest file to commit' })).not.toBeInTheDocument()

  await go('Commits')
  expect(screen.getByRole('group', { name: 'Largest file to commit' })).toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'Keep a daily note' })).not.toBeInTheDocument()
})

test('the section you are in is the one expanded in the rail', async () => {
  setup()
  const rail = await screen.findByRole('navigation', { name: 'Settings sections' })
  // Selection IS expansion, so Appearance's token groups are only offered while
  // Appearance is what you are looking at.
  expect(within(rail).queryByRole('button', { name: 'Surfaces' })).not.toBeInTheDocument()

  await go('Appearance')
  expect(within(rail).getByRole('button', { name: 'Surfaces' })).toBeInTheDocument()

  await go('Commits')
  // A group closes by sliding shut, and leaves once the slide has ended.
  for (const closing of rail.querySelectorAll('[data-slot="disclose"][data-state="closed"]')) {
    fireEvent.transitionEnd(closing)
  }
  expect(within(rail).queryByRole('button', { name: 'Surfaces' })).not.toBeInTheDocument()
})

test('says which layer each value comes from', async () => {
  setup()
  // Without this the pane can silently commit a machine-local preference, which
  // for appearance is exactly the failure the `.local` layer exists to prevent.
  const daily = await screen.findByRole('group', { name: 'Keep a daily note' })
  expect(within(daily).getByText('vault')).toBeInTheDocument()

  await go('Appearance')
  const appearance = await screen.findByRole('group', { name: 'Appearance' })
  expect(within(appearance).getByText('this machine')).toBeInTheDocument()
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

  await go('Appearance')
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
  // Twice: once on mount, once forced after the write, because the atom caches
  // per vault.
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
})

test('shows the resolver’s complaint beside the setting it names', async () => {
  // Otherwise a malformed value is replaced by a default and never mentioned.
  setup({ warnings: ['dropped "dailyNotes": expected a boolean, got "yes"'] })
  const daily = await screen.findByRole('group', { name: 'Keep a daily note' })
  expect(within(daily).getByText(/expected a boolean/)).toBeInTheDocument()
})

test('offers the files the section on screen is a view of', async () => {
  // Per section: the point is saying WHICH file backs what you are looking at.
  setup()
  expect(await screen.findByRole('button', { name: '.holi/settings/app.yaml' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '.holi/settings/theme.css' })).not.toBeInTheDocument()

  await go('Appearance')
  expect(screen.getByRole('button', { name: '.holi/settings/theme.css' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '.holi/settings/theme.local.css' })).toBeInTheDocument()
})
