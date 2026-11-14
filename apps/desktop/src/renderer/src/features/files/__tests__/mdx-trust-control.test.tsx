import { createStore, Provider } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, render, screen, waitFor } from '@/test/render'
import { sessionAtom } from '@/state/session'
import { activeRemoteAtom } from '@/state/vaults'
import { MdxTrustControl } from '../mdx-trust-control'

const status = vi.fn()
const approve = vi.fn()
const revoke = vi.fn()
vi.mock('@/lib/trpc', () => ({
  trpc: {
    mdxTrust: {
      status: { query: (input: unknown) => status(input) },
      approve: { mutate: (input: unknown) => approve(input) },
      revoke: { mutate: (input: unknown) => revoke(input) },
    },
  },
}))

const unapproved = { trusted: false, identityAvailable: true, context: 'main-context' }

beforeEach(() => {
  status.mockReset().mockResolvedValue(unapproved)
  approve.mockReset().mockResolvedValue({ trusted: true })
  revoke.mockReset().mockResolvedValue({ trusted: false })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, 'fixture/vault')
  store.set(sessionAtom, { login: 'fixture-person' })
  const tree = (props: { path?: string; visible?: boolean; focused?: boolean } = {}) => (
    <Provider store={store}>
      <MdxTrustControl
        remote="fixture/vault"
        path={props.path ?? 'first.mdx'}
        visible={props.visible ?? true}
        focused={props.focused ?? true}
      />
    </Provider>
  )
  const result = render(tree())
  return { store, update: (props: Parameters<typeof tree>[0]) => result.rerender(tree(props)) }
}

async function review() {
  await userEvent.click(await screen.findByRole('button', { name: 'Review MDX trust' }))
  return screen.findByRole('dialog')
}

test('confirmation explains vault-wide future changes and cancellation never grants trust', async () => {
  setup()
  const dialog = await review()
  expect(dialog).toHaveTextContent('fixture/vault')
  expect(dialog).toHaveTextContent('including future documents and synced changes')
  expect(dialog).toHaveTextContent('does not enable preview or grant network')
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(approve).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('approval sends the main-owned context and refreshes trust status', async () => {
  setup()
  await review()
  status.mockResolvedValue({ ...unapproved, trusted: true })
  await userEvent.click(screen.getByRole('button', { name: 'Approve vault' }))
  await screen.findByText('Approved')
  expect(approve).toHaveBeenCalledExactlyOnceWith({
    remote: 'fixture/vault',
    context: 'main-context',
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('failed approval stays in the dialog and can be retried without reporting success', async () => {
  approve.mockRejectedValueOnce(new Error('disk full'))
  setup()
  await review()
  await userEvent.click(screen.getByRole('button', { name: 'Approve vault' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('disk full')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.queryByText('Approved')).not.toBeInTheDocument()
  status.mockResolvedValue({ ...unapproved, trusted: true })
  await userEvent.click(screen.getByRole('button', { name: 'Retry approval' }))
  await screen.findByText('Approved')
  expect(approve).toHaveBeenCalledTimes(2)
})

test('revocation and failed-write retry use the original main-owned context', async () => {
  status.mockResolvedValue({ ...unapproved, trusted: true })
  revoke.mockRejectedValueOnce(new Error('read-only disk'))
  setup()
  await userEvent.click(await screen.findByRole('button', { name: 'Revoke MDX trust' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('read-only disk')
  expect(screen.getByText('Approved')).toBeInTheDocument()
  status.mockResolvedValue(unapproved)
  await userEvent.click(screen.getByRole('button', { name: 'Retry revoke' }))
  await screen.findByText('Not approved')
  expect(revoke).toHaveBeenCalledTimes(2)
  expect(revoke).toHaveBeenLastCalledWith({ remote: 'fixture/vault', context: 'main-context' })
})

test('failed status has an inline Retry and cannot open an approval dialog', async () => {
  status.mockRejectedValueOnce(new Error('unsupported trust state'))
  setup()
  expect(await screen.findByRole('alert')).toHaveTextContent('unsupported trust state')
  expect(screen.queryByRole('button', { name: 'Review MDX trust' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Not approved')
})

test('A to B to A closes the old confirmation even when transitions batch into one render', async () => {
  const { store } = setup()
  await review()
  act(() => {
    store.set(activeRemoteAtom, 'fixture/other')
    store.set(activeRemoteAtom, 'fixture/vault')
  })
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(approve).not.toHaveBeenCalled()
  await review()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('a same-login account replacement invalidates the old confirmation', async () => {
  const { store } = setup()
  await review()
  act(() => store.set(sessionAtom, { login: 'fixture-person' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(approve).not.toHaveBeenCalled()
})

test('sign-out discards approved UI and cannot approve without an identity', async () => {
  status.mockResolvedValue({ ...unapproved, trusted: true })
  const { store } = setup()
  await screen.findByText('Approved')
  act(() => store.set(sessionAtom, null))
  await screen.findByText('Sign in required')
  expect(screen.getByRole('button', { name: 'Review MDX trust' })).toBeDisabled()
  expect(screen.queryByText('Approved')).not.toBeInTheDocument()
})

test('old status cannot replace a new A activation after departure and return', async () => {
  const oldStatus = deferred<typeof unapproved>()
  status.mockReturnValueOnce(oldStatus.promise)
  const { store } = setup()
  await waitFor(() => expect(status).toHaveBeenCalledTimes(1))
  act(() => {
    store.set(activeRemoteAtom, 'fixture/other')
    store.set(activeRemoteAtom, 'fixture/vault')
  })
  await screen.findByText('Not approved')
  await act(async () => oldStatus.resolve({ ...unapproved, trusted: true }))
  expect(screen.queryByText('Approved')).not.toBeInTheDocument()
})

test('late action failure cannot leak into a replacement source view', async () => {
  const action = deferred<{ trusted: boolean }>()
  approve.mockReturnValueOnce(action.promise)
  const { update } = setup()
  await review()
  await userEvent.click(screen.getByRole('button', { name: 'Approve vault' }))
  update({ path: 'replacement.mdx' })
  await screen.findByText('Not approved')
  await act(async () => action.reject(new Error('old owner failure')))
  expect(screen.queryByText('old owner failure')).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Review MDX trust' })).toBeEnabled()
})

test('late success cannot close or clear the pending state of a new confirmation', async () => {
  const oldAction = deferred<{ trusted: boolean }>()
  const newAction = deferred<{ trusted: boolean }>()
  approve.mockReturnValueOnce(oldAction.promise).mockReturnValueOnce(newAction.promise)
  const { update } = setup()
  await review()
  await userEvent.click(screen.getByRole('button', { name: 'Approve vault' }))
  update({ path: 'replacement.mdx' })
  await review()
  await userEvent.click(screen.getByRole('button', { name: 'Approve vault' }))
  await act(async () => oldAction.resolve({ trusted: true }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled()
  await act(async () => newAction.resolve({ trusted: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})

test('hidden and unfocused source controls cannot approve, and losing focus closes confirmation', async () => {
  const { update } = setup()
  await review()
  update({ focused: false })
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(await screen.findByRole('button', { name: 'Review MDX trust' })).toBeDisabled()
  update({ visible: false })
  expect(screen.queryByRole('button', { name: 'Review MDX trust' })).not.toBeInTheDocument()
  expect(approve).not.toHaveBeenCalled()
})

test('vault-wide mutations refresh other visible split source views', async () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'fixture/vault')
  store.set(sessionAtom, { login: 'fixture-person' })
  render(
    <Provider store={store}>
      <MdxTrustControl remote="fixture/vault" path="first.mdx" visible focused />
      <MdxTrustControl remote="fixture/vault" path="second.mdx" visible focused={false} />
    </Provider>,
  )
  await waitFor(() => expect(screen.getAllByText('Not approved')).toHaveLength(2))
  const controls = screen.getAllByRole('button', { name: 'Review MDX trust' })
  expect(controls[1]).toBeDisabled()
  await userEvent.click(controls[0]!)
  status.mockResolvedValue({ ...unapproved, trusted: true })
  await userEvent.click(screen.getByRole('button', { name: 'Approve vault' }))
  await waitFor(() => expect(screen.getAllByText('Approved')).toHaveLength(2))
  expect(approve).toHaveBeenCalledTimes(1)
})

test('a stale main context requires a fresh confirmation instead of retrying its old authority', async () => {
  approve.mockRejectedValueOnce(new Error('MDX trust context changed'))
  setup()
  await review()
  status.mockResolvedValue({ ...unapproved, context: 'replacement-context' })
  await userEvent.click(screen.getByRole('button', { name: 'Approve vault' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await review()
  await userEvent.click(screen.getByRole('button', { name: 'Approve vault' }))
  await waitFor(() => expect(approve).toHaveBeenCalledTimes(2))
  expect(approve).toHaveBeenLastCalledWith({
    remote: 'fixture/vault',
    context: 'replacement-context',
  })
})

test('a pending revoke refreshes both split views after focus moves to its peer', async () => {
  status.mockResolvedValue({ ...unapproved, trusted: true })
  const action = deferred<{ trusted: boolean }>()
  revoke.mockReturnValueOnce(action.promise)
  const store = createStore()
  store.set(activeRemoteAtom, 'fixture/vault')
  store.set(sessionAtom, { login: 'fixture-person' })
  const split = (firstFocused: boolean) => (
    <Provider store={store}>
      <MdxTrustControl remote="fixture/vault" path="first.mdx" visible focused={firstFocused} />
      <MdxTrustControl remote="fixture/vault" path="second.mdx" visible focused={!firstFocused} />
    </Provider>
  )
  const result = render(split(true))
  await waitFor(() => expect(screen.getAllByText('Approved')).toHaveLength(2))
  await userEvent.click(screen.getAllByRole('button', { name: 'Revoke MDX trust' })[0]!)
  result.rerender(split(false))
  await waitFor(() => expect(screen.getAllByText('Approved')).toHaveLength(2))
  status.mockResolvedValue(unapproved)
  await act(async () => action.resolve({ trusted: false }))
  await waitFor(() => expect(screen.getAllByText('Not approved')).toHaveLength(2))
})

test('an approval refreshes its peer even when the originating source view unmounts', async () => {
  const action = deferred<{ trusted: boolean }>()
  approve.mockReturnValueOnce(action.promise)
  const store = createStore()
  store.set(activeRemoteAtom, 'fixture/vault')
  store.set(sessionAtom, { login: 'fixture-person' })
  const split = (firstVisible: boolean) => (
    <Provider store={store}>
      {firstVisible ? (
        <MdxTrustControl key="first" remote="fixture/vault" path="first.mdx" visible focused />
      ) : null}
      <MdxTrustControl
        key="second"
        remote="fixture/vault"
        path="second.mdx"
        visible
        focused={false}
      />
    </Provider>
  )
  const result = render(split(true))
  await waitFor(() => expect(screen.getAllByText('Not approved')).toHaveLength(2))
  await userEvent.click(screen.getAllByRole('button', { name: 'Review MDX trust' })[0]!)
  await userEvent.click(screen.getByRole('button', { name: 'Approve vault' }))
  result.rerender(split(false))
  status.mockResolvedValue({ ...unapproved, trusted: true })
  await act(async () => action.resolve({ trusted: true }))
  await screen.findByText('Approved')
})
