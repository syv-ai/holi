/**
 * The theme's controls (#16's second gap, over D64).
 *
 * The three things worth pinning are the ones a later tidy-up would get wrong:
 * the pane renders every whitelisted token rather than a list of its own, a
 * reset DELETES the key rather than writing a blank, and the two axes (mode and
 * layer) decide where a write lands rather than what is shown.
 */
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { THEME_TOKENS } from '@holi/shared'
import { ThemeSection } from '../ThemeSection'

const themeRead = vi.fn()
const themeWrite = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    theme: {
      read: { query: () => themeRead() },
      write: { mutate: (input: unknown) => themeWrite(input) },
    },
  },
}))

const REMOTE = 'syv-ai/holi'

function setup(theme: { light?: object; dark?: object; warnings?: string[] } = {}) {
  themeRead.mockResolvedValue({ light: {}, dark: {}, warnings: [], ...theme })
  themeWrite.mockResolvedValue({ ok: true, warnings: [] })
  return render(
    <Provider store={createStore()}>
      <ThemeSection remote={REMOTE} />
    </Provider>,
  )
}

const patchOf = (call: number = 0) => JSON.parse(themeWrite.mock.calls[call]![0].patchJson)

beforeEach(() => {
  themeRead.mockReset()
  themeWrite.mockReset()
})

test('renders a control for every whitelisted token', async () => {
  // From `THEME_TOKEN_GROUPS`, not a list here — so a token added to the
  // whitelist appears without this file being touched.
  setup()
  await waitFor(() => expect(screen.getByText('Surfaces')).toBeInTheDocument())

  for (const slug of THEME_TOKENS) {
    expect(screen.getByText(`--${slug}`)).toBeInTheDocument()
  }
})

test('marks a token the vault has not set as a default', async () => {
  setup({ dark: { primary: '#ff0000' } })
  await waitFor(() => expect(screen.getByText('--primary')).toBeInTheDocument())

  // One row is set, so it carries no "default" marker; the rest do.
  const defaults = screen.getAllByText('default')
  expect(defaults.length).toBe(THEME_TOKENS.length - 1)
})

test('a reset writes null, which is what deletes the key', async () => {
  // Not an empty string: that is dropped as invalid and would leave the old
  // colour in place, so the button would appear to do nothing.
  setup({ dark: { primary: '#ff0000' } })
  await waitFor(() => expect(screen.getByText('--primary')).toBeInTheDocument())

  await userEvent.click(screen.getByRole('button', { name: 'reset Primary' }))

  await waitFor(() => expect(themeWrite).toHaveBeenCalled())
  expect(patchOf()).toEqual({ dark: { primary: null } })
})

test('cannot reset a token that is already the default', async () => {
  setup()
  await waitFor(() => expect(screen.getByText('--primary')).toBeInTheDocument())

  expect(screen.getByRole('button', { name: 'reset Primary' })).toBeDisabled()
})

test('writes into the mode on screen, and switching mode switches the target', async () => {
  setup()
  await waitFor(() => expect(screen.getByText('--radius')).toBeInTheDocument())

  await userEvent.click(screen.getByRole('radio', { name: 'Light' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Radius' }), '1rem')
  await userEvent.tab()

  await waitFor(() => expect(themeWrite).toHaveBeenCalled())
  expect(patchOf()).toEqual({ light: { radius: '1rem' } })
})

test('the layer decides which file a write lands in', async () => {
  setup()
  await waitFor(() => expect(screen.getByText('--radius')).toBeInTheDocument())

  expect(themeWrite).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('radio', { name: 'This machine' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Radius' }), '1rem')
  await userEvent.tab()

  await waitFor(() => expect(themeWrite).toHaveBeenCalled())
  expect(themeWrite.mock.calls[0]![0].layer).toBe('local')
})

test('defaults to writing the shared file', async () => {
  setup()
  await waitFor(() => expect(screen.getByText('--radius')).toBeInTheDocument())

  await userEvent.type(screen.getByRole('textbox', { name: 'Radius' }), '1rem')
  await userEvent.tab()

  await waitFor(() => expect(themeWrite).toHaveBeenCalled())
  expect(themeWrite.mock.calls[0]![0].layer).toBe('committed')
})

test('surfaces a refused value rather than swallowing it', async () => {
  // The pane's validator is the file's validator, so a refusal here means the
  // colour did not stick — saying nothing would read as a control that works.
  themeRead.mockResolvedValue({ light: {}, dark: {}, warnings: [] })
  themeWrite.mockResolvedValue({ ok: true, warnings: ['refused "radius" (dark): "5 dogs"'] })
  render(
    <Provider store={createStore()}>
      <ThemeSection remote={REMOTE} />
    </Provider>,
  )
  await waitFor(() => expect(screen.getByText('--radius')).toBeInTheDocument())

  await userEvent.type(screen.getByRole('textbox', { name: 'Radius' }), '5 dogs')
  await userEvent.tab()

  await waitFor(() => expect(screen.getByText(/refused "radius"/)).toBeInTheDocument())
})

test('shows the resolver’s own warnings about the files', async () => {
  setup({ warnings: ['dropped unknown token "position" (dark)'] })
  await waitFor(() =>
    expect(screen.getByText('dropped unknown token "position" (dark)')).toBeInTheDocument(),
  )
})
