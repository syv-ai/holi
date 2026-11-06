import { act, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { fireEvent } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { NewSessionButton } from '../renderer/sessions/new-session-button'
import { pickedProviderAtom, providersAtom } from '../renderer/state/providers'

const starts = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, sessionId: 'p0123456789ab', terminalId: 't1' })),
)
const providerListing = vi.hoisted(() => vi.fn())
vi.mock('../renderer/agent-cap', () => ({
  agentCap: { start: starts, providers: providerListing },
}))

const providers = [
  {
    id: 'claude',
    label: 'Claude Code',
    installed: true,
    background: true,
    jobs: true,
    resumePicker: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    installed: true,
    background: true,
    jobs: true,
    resumePicker: false,
  },
  { id: 'pi', label: 'Pi', installed: false, background: false, jobs: false, resumePicker: false },
] as const

function setup({
  listing = providers,
}: { listing?: readonly (typeof providers)[number][] | Error } = {}) {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  providerListing.mockImplementation(async () => {
    if (listing instanceof Error) throw listing
    return listing
  })
  render(
    <Provider store={store}>
      <NewSessionButton />
    </Provider>,
  )
  return store
}

beforeEach(() => {
  vi.useRealTimers()
  starts.mockClear()
  providerListing.mockClear()
})

test('opens choices on click without launching and orders the default first', async () => {
  setup()
  await userEvent.click(screen.getByRole('button', { name: /^New .*session/ }))
  expect(await screen.findByRole('menu')).toBeInTheDocument()
  expect(starts).not.toHaveBeenCalled()
  const items = screen.getAllByRole('menuitem')
  expect(items[0]).toHaveTextContent('Claude Code')
  expect(items[1]).toHaveTextContent('Codex')
  expect(items[2]).toHaveTextContent('Pi')
})

test('puts a non-first default before other providers without launching', async () => {
  const store = setup()
  act(() => store.set(pickedProviderAtom, 'codex'))
  screen.getByRole('button', { name: /^New .*session/ }).focus()
  await userEvent.keyboard('{ArrowDown}')
  const items = await screen.findAllByRole('menuitem')
  expect(items[0]).toHaveTextContent('Codex')
  expect(items[1]).toHaveTextContent('Claude Code')
  expect(starts).not.toHaveBeenCalled()
})

test('touch opens choices without launching', async () => {
  setup()
  const trigger = screen.getByRole('button', { name: /^New .*session/ })
  await userEvent.pointer([{ target: trigger, keys: '[TouchA>]' }, { keys: '[/TouchA]' }])
  expect(await screen.findByRole('menu')).toBeInTheDocument()
  expect(starts).not.toHaveBeenCalled()
})

test('hovering never opens the menu or launches a session', async () => {
  vi.useFakeTimers()
  setup()
  const trigger = screen.getByRole('button', { name: /^New .*session/ })
  act(() => fireEvent.pointerEnter(trigger))
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(starts).not.toHaveBeenCalled()
  vi.useRealTimers()
})

test.each(['{Enter}', ' '])('%s opens the menu and Escape restores focus', async (key) => {
  setup()
  const trigger = screen.getByRole('button', { name: /^New .*session/ })
  trigger.focus()
  await userEvent.keyboard(key)
  expect(await screen.findByRole('menu')).toBeInTheDocument()
  expect(starts).not.toHaveBeenCalled()
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(trigger).toHaveFocus())
})

test('ArrowDown opens the choices without starting a session', async () => {
  setup()
  screen.getByRole('button', { name: /^New .*session/ }).focus()
  await userEvent.keyboard('{ArrowDown}')
  expect(await screen.findByRole('menu')).toBeInTheDocument()
  expect(starts).not.toHaveBeenCalled()
})

test('launches only the selected provider and resumes only by explicit selection', async () => {
  setup()
  await userEvent.click(screen.getByRole('button', { name: /^New .*session/ }))
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Claude Code/ }))
  await waitFor(() => expect(starts).toHaveBeenCalledTimes(1))
  expect(starts).toHaveBeenCalledWith('o/vault', expect.objectContaining({ provider: 'claude' }))

  starts.mockClear()
  await userEvent.click(screen.getByRole('button', { name: /^New .*session/ }))
  await userEvent.click(await screen.findByRole('menuitem', { name: /Codex/ }))
  await waitFor(() => expect(starts).toHaveBeenCalledTimes(1))
  expect(starts).toHaveBeenCalledWith('o/vault', expect.objectContaining({ provider: 'codex' }))

  starts.mockClear()
  await userEvent.click(screen.getByRole('button', { name: /^New .*session/ }))
  await userEvent.click(
    await screen.findByRole('menuitem', { name: /Resume a Claude Code conversation/ }),
  )
  await waitFor(() => expect(starts).toHaveBeenCalledTimes(1))
  expect(starts).toHaveBeenCalledWith(
    'o/vault',
    expect.objectContaining({ provider: 'claude', resume: 'pick' }),
  )
})

test('disabled uninstalled provider cannot start', async () => {
  setup()
  await userEvent.click(screen.getByRole('button', { name: /^New .*session/ }))
  expect(await screen.findByRole('menuitem', { name: /Pi/ })).toHaveAttribute('data-disabled')
  expect(starts).not.toHaveBeenCalled()
})

test('missing configured default warns and never silently substitutes', async () => {
  setup({
    listing: providers.filter((provider) => provider.id !== 'claude'),
  })
  await userEvent.click(screen.getByRole('button', { name: /^New .*session/ }))
  expect(await screen.findByText(/claude is gone/i)).toBeInTheDocument()
  expect(starts).not.toHaveBeenCalled()
})

test('loading, error retry, and ready-empty states are announced', async () => {
  const store = setup({ listing: new Error('offline') })
  providerListing.mockImplementation(() => new Promise(() => {}))
  store.set(providersAtom, { kind: 'loading' })
  await userEvent.click(screen.getByRole('button', { name: /^New .*session/ }))
  expect(await screen.findByRole('status')).toHaveTextContent(/reading the agents/i)

  act(() => store.set(providersAtom, { kind: 'error', message: 'offline' }))
  expect(await screen.findByRole('status')).toHaveTextContent(/couldn't list the agents/i)
  expect(await screen.findByRole('menuitem', { name: /retry/i })).toBeInTheDocument()
  providerListing.mockImplementation(async () => providers)
  await userEvent.click(screen.getByRole('menuitem', { name: /retry/i }))
  await waitFor(() => expect(store.get(providersAtom).kind).toBe('ready'))
  expect(providerListing).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('menu')).toBeInTheDocument()

  act(() => store.set(providersAtom, { kind: 'ready', providers: [] }))
  expect(screen.getByRole('status')).toHaveTextContent(/no agents available/i)
})

test('outside dismissal keeps focus on the outside control', async () => {
  setup()
  const outside = document.createElement('button')
  outside.textContent = 'Outside'
  document.body.append(outside)
  try {
    await userEvent.click(screen.getByRole('button', { name: /^New .*session/ }))
    await userEvent.click(outside)
    await waitFor(() => expect(outside).toHaveFocus())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  } finally {
    outside.remove()
  }
})

test('launching preserves focus handed to the new session', async () => {
  setup()
  const session = document.createElement('button')
  session.textContent = 'Session terminal'
  document.body.append(session)
  starts.mockImplementationOnce(async () => {
    session.focus()
    return { ok: true, sessionId: 'p0123456789ab', terminalId: 't1' }
  })
  try {
    await userEvent.click(screen.getByRole('button', { name: /^New .*session/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Codex/ }))
    await waitFor(() => expect(starts).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(session).toHaveFocus()
  } finally {
    session.remove()
  }
})
