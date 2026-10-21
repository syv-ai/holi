/**
 * The theme's controls.
 *
 * The pane renders every whitelisted token rather than a list of its own, a
 * reset DELETES the key rather than writing a blank, a cell writes into its own
 * palette, and the layer decides where a write lands rather than what is shown.
 */
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { THEME_TOKENS, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { ThemeSection } from '../ThemeSection'
import { activeRemoteAtom } from '@/state/vaults'

const themeRead = vi.fn()
const themeWrite = vi.fn()
const settingsRead = vi.fn()
const settingsWrite = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    theme: {
      read: { query: () => themeRead() },
      holi: { query: () => Promise.resolve(HOLI) },
      write: { mutate: (input: unknown) => themeWrite(input) },
    },
    // Appearance carries the `colorScheme` descriptor row as well, so this mock
    // has to answer for the settings file too, or every test here logs an
    // unhandled rejection.
    settings: {
      read: { query: () => settingsRead() },
      write: { mutate: (input: unknown) => settingsWrite(input) },
    },
  },
}))

const REMOTE = 'syv-ai/holi'

/** Holi's own theme, as main answers it: one token is enough to test against. */
const HOLI = { light: {}, dark: { primary: '#0069a8' } }

/** The store the section needs: a remote, because the settings row reads the
 *  active vault's file. */
function store() {
  const s = createStore()
  s.set(activeRemoteAtom, REMOTE)
  return s
}

function setup(theme: { light?: object; dark?: object; warnings?: string[] } = {}) {
  themeRead.mockResolvedValue({ light: {}, dark: {}, warnings: [], ...theme })
  themeWrite.mockResolvedValue({ ok: true, warnings: [] })
  settingsRead.mockResolvedValue({ ...VAULT_SETTING_DEFAULTS, warnings: [] })
  settingsWrite.mockResolvedValue({ ok: true, warnings: [] })
  return render(
    <Provider store={store()}>
      <ThemeSection remote={REMOTE} />
    </Provider>,
  )
}

const patchOf = (call: number = 0) => JSON.parse(themeWrite.mock.calls[call]![0].patchJson)

beforeEach(() => {
  themeRead.mockReset()
  themeWrite.mockReset()
  settingsRead.mockReset()
  settingsWrite.mockReset()
})

test('renders a control for every whitelisted token', async () => {
  // From `THEME_TOKEN_GROUPS`, not a list here, so a token added to the
  // whitelist appears without this file being touched.
  setup()
  await waitFor(() => expect(screen.getByText('Surfaces')).toBeInTheDocument())

  for (const slug of THEME_TOKENS) {
    expect(screen.getByText(`--${slug}`)).toBeInTheDocument()
  }
})

test('offers a reset only where the vault differs from Holi', async () => {
  setup({ dark: { primary: '#ff0000' } })
  await waitFor(() => expect(screen.getByText('--primary')).toBeInTheDocument())

  // One cell differs from Holi's, so one reset is live; every other cell, in
  // both palettes, is Holi's.
  const live = screen
    .getAllByRole('button', { name: /^reset / })
    .filter((b) => b.getAttribute('aria-disabled') !== 'true')
  expect(live.map((b) => b.getAttribute('aria-label'))).toEqual(['reset Brand, as a fill in dark'])
  expect(screen.getAllByRole('button', { name: /^reset / })).toHaveLength(THEME_TOKENS.length * 2)
})

test('a reset writes Holi’s value back', async () => {
  setup({ dark: { primary: '#ff0000' } })
  await waitFor(() => expect(screen.getByText('--primary')).toBeInTheDocument())

  await userEvent.click(screen.getByRole('button', { name: 'reset Brand, as a fill in dark' }))

  await waitFor(() => expect(themeWrite).toHaveBeenCalled())
  expect(patchOf()).toEqual({ dark: { primary: '#0069a8' } })
})

test('cannot reset a token that is already Holi’s', async () => {
  setup({ dark: { primary: '#0069a8' } })
  await waitFor(() => expect(screen.getByText('--primary')).toBeInTheDocument())

  expect(screen.getByRole('button', { name: 'reset Brand, as a fill in dark' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
})

test('a cell writes into its own palette', async () => {
  setup()
  await waitFor(() => expect(screen.getByText('--radius')).toBeInTheDocument())

  await userEvent.type(screen.getByRole('textbox', { name: 'Corner rounding in light' }), '1rem')
  await userEvent.tab()

  await waitFor(() => expect(themeWrite).toHaveBeenCalled())
  expect(patchOf()).toEqual({ light: { radius: '1rem' } })
})

test('the layer decides which file a write lands in', async () => {
  setup()
  await waitFor(() => expect(screen.getByText('--radius')).toBeInTheDocument())

  expect(themeWrite).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('radio', { name: 'This machine' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Corner rounding in dark' }), '1rem')
  await userEvent.tab()

  await waitFor(() => expect(themeWrite).toHaveBeenCalled())
  expect(themeWrite.mock.calls[0]![0].layer).toBe('local')
})

test('defaults to writing the shared file', async () => {
  setup()
  await waitFor(() => expect(screen.getByText('--radius')).toBeInTheDocument())

  await userEvent.type(screen.getByRole('textbox', { name: 'Corner rounding in dark' }), '1rem')
  await userEvent.tab()

  await waitFor(() => expect(themeWrite).toHaveBeenCalled())
  expect(themeWrite.mock.calls[0]![0].layer).toBe('committed')
})

test('surfaces a refused value rather than swallowing it', async () => {
  // The pane's validator is the file's validator, so a refusal here means the
  // colour did not stick; saying nothing would read as a control that works.
  themeRead.mockResolvedValue({ light: {}, dark: {}, warnings: [] })
  themeWrite.mockResolvedValue({ ok: true, warnings: ['refused "radius" (dark): "5 dogs"'] })
  settingsRead.mockResolvedValue({ ...VAULT_SETTING_DEFAULTS, warnings: [] })
  settingsWrite.mockResolvedValue({ ok: true, warnings: [] })
  render(
    <Provider store={store()}>
      <ThemeSection remote={REMOTE} />
    </Provider>,
  )
  await waitFor(() => expect(screen.getByText('--radius')).toBeInTheDocument())

  await userEvent.type(screen.getByRole('textbox', { name: 'Corner rounding in dark' }), '5 dogs')
  await userEvent.tab()

  await waitFor(() => expect(screen.getByText(/refused "radius"/)).toBeInTheDocument())
})

test('shows the resolver’s own warnings about the files', async () => {
  setup({ warnings: ['dropped unknown token "position" (dark)'] })
  await waitFor(() =>
    expect(screen.getByText('dropped unknown token "position" (dark)')).toBeInTheDocument(),
  )
})
