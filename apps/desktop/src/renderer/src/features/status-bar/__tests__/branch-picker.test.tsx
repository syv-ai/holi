/**
 * The status bar's branch picker (docs/features/status-bar.md): what it lists,
 * what choosing does, the inline name check, and its loading and error states.
 */
import { Provider, createStore } from 'jotai'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { fireEvent, render, screen, waitFor } from '@/test/render'
import { activeRemoteAtom } from '@/state/vaults'

import { StatusBar } from '../status-bar'

const calls: { name: string; input: unknown }[] = []
let branches: () => Promise<unknown>
let switchAnswer: (input: unknown) => Promise<unknown>

const LIST = {
  current: 'main',
  local: [
    { name: 'main', upstream: 'origin/main' },
    { name: 'draft', upstream: null },
  ],
  remote: [{ name: 'topic' }],
}

vi.mock('@/lib/trpc', () => {
  const answer = (name: string, input: unknown): unknown => {
    if (name === 'sync.info')
      return {
        remote: 'o/r',
        branch: 'main',
        dirty: false,
        ahead: 0,
        behind: 0,
        lastSyncAt: null,
        lastError: null,
      }
    if (name === 'sync.branches') return branches()
    if (name === 'sync.switchBranch') return switchAnswer(input)
    if (name === 'sync.branchNameValid') return !/\s|\.\./.test((input as { name: string }).name)
    if (name === 'activity.entries') return []
    return { ok: true }
  }
  const procedure = (name: string) => ({
    query: async (input?: unknown) => {
      calls.push({ name, input })
      return answer(name, input)
    },
    mutate: async (input?: unknown) => {
      calls.push({ name, input })
      return answer(name, input)
    },
  })
  const router = (r: string) =>
    new Proxy(
      {},
      {
        get: (_t, key) => (typeof key === 'string' ? procedure(`${r}.${key}`) : undefined),
      },
    )
  return {
    trpc: new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? router(key) : undefined) }),
  }
})

beforeEach(() => {
  calls.length = 0
  branches = async () => LIST
  switchAnswer = async () => ({ ok: true })
})

async function openPicker() {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/r')
  render(
    <Provider store={store}>
      <StatusBar />
    </Provider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: /^Branch main/ }))
  return store
}

const called = (name: string) => calls.filter((c) => c.name === name)

describe('branch picker', () => {
  test('lists local branches with the current one checked, then remote-only ones, and fetches', async () => {
    await openPicker()
    expect(await screen.findByPlaceholderText('Switch to a branch')).toBeInTheDocument()
    const main = await screen.findByRole('option', { name: /^main/ })
    expect(main).toHaveAttribute('data-checked', 'true')
    expect(screen.getByRole('option', { name: /^draft/ })).toHaveAttribute('data-checked', 'false')
    expect(screen.getByText('not published')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'origin/topic' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Create branch…' })).toBeInTheDocument()
    await waitFor(() => expect(called('sync.fetchBranches')).toHaveLength(1))
  })

  test('choosing a remote branch switches to it', async () => {
    await openPicker()
    fireEvent.click(await screen.findByRole('option', { name: 'origin/topic' }))
    await waitFor(() =>
      expect(called('sync.switchBranch')[0]?.input).toEqual({
        name: 'topic',
        create: false,
      }),
    )
  })

  test('a refusal is shown in the picker, which stays open', async () => {
    switchAnswer = async () => {
      throw new Error('A merge conflict is waiting. Resolve it before switching.')
    }
    await openPicker()
    fireEvent.click(await screen.findByRole('option', { name: /^draft/ }))
    expect(
      await screen.findByText('A merge conflict is waiting. Resolve it before switching.'),
    ).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Switch to a branch')).toBeVisible()
  })

  test('Create branch checks the name inline, then creates it', async () => {
    await openPicker()
    fireEvent.change(await screen.findByPlaceholderText('Switch to a branch'), {
      target: { value: 'bad name' },
    })
    fireEvent.click(await screen.findByRole('option', { name: 'Create branch “bad name”…' }))
    const input = await screen.findByLabelText('New branch from main')
    expect(input).toHaveValue('bad name')
    expect(await screen.findByText('“bad name” is not a valid branch name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create branch' })).toBeDisabled()

    fireEvent.change(input, { target: { value: 'draft' } })
    expect(await screen.findByText('A branch named “draft” already exists')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'feat/notes' } })
    const create = screen.getByRole('button', { name: 'Create branch' })
    await waitFor(() => expect(create).toBeEnabled())
    fireEvent.click(create)
    await waitFor(() =>
      expect(called('sync.switchBranch')[0]?.input).toEqual({
        name: 'feat/notes',
        create: true,
      }),
    )
  })

  test('loads with a skeleton, and a failed list offers Retry', async () => {
    let fail = true
    let release: () => void = () => {}
    branches = () =>
      fail
        ? Promise.reject(new Error('no vault is open'))
        : new Promise((resolve) => {
            release = () => resolve(LIST)
          })
    await openPicker()
    expect(await screen.findByText('Could not list the branches')).toBeInTheDocument()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('status', { name: 'Loading branches' })).toBeInTheDocument()
    release()
    expect(await screen.findByRole('option', { name: 'origin/topic' })).toBeInTheDocument()
  })
})
