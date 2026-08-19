/**
 * The frame a vault app runs in — the renderer half of the boundary.
 *
 * What these tests are about is identity and isolation, not rendering: the frame
 * must be sandboxed in the exact way that leaves its origin opaque, it must
 * answer only the frame it mounted, and it must pass the vault its own idea of
 * which app is speaking rather than the app's.
 */
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { AppFrame } from '../AppFrame'
import { snapshotAtom, activeRemoteAtom } from '../../../state/vaults'
import { workspaceAtom, openApp } from '../../../state/panes'

const docsMock = vi.fn((_input: unknown) =>
  Promise.resolve([{ path: 'a.md', kind: 'note', updatedAt: '' }]),
)
const readMock = vi.fn((_input: unknown) => Promise.resolve('# A'))
const tasksMock = vi.fn((_input: unknown) => Promise.resolve([]))

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    apps: {
      docs: { query: (input: unknown) => docsMock(input) },
      read: { query: (input: unknown) => readMock(input) },
      tasks: { query: (input: unknown) => tasksMock(input) },
    },
  },
}))

const REMOTE = 'syv-ai/1brain'
const store = getDefaultStore()

function withApps(...ids: string[]) {
  store.set(activeRemoteAtom, REMOTE)
  store.set(snapshotAtom, {
    docs: [],
    tasks: [],
    broken: [],
    dirs: [],
    files: ids.map((id) => ({ path: `.holi/apps/${id}/index.html`, updatedAt: '' })),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  withApps('retro')
  store.set(workspaceAtom, openApp({ panes: [{ tabs: [], active: -1 }], active: 0 }, 'retro'))
})

const frameOf = () => document.querySelector('iframe')!

/** A message as the frame itself would send it. */
function fromFrame(data: unknown, source: Window | null = frameOf().contentWindow) {
  window.dispatchEvent(new MessageEvent('message', { data, source }))
}

test('serves the app from its own origin', async () => {
  render(<AppFrame appId="retro" />)
  expect(frameOf().getAttribute('src')).toBe('holi-app://retro/index.html')
})

test('is sandboxed WITHOUT allow-same-origin', () => {
  // The mail frame is the exact opposite (`allow-same-origin` and no scripts),
  // and the pair of tests is what says these two are deliberate opposites.
  // Granting both is the footgun that lets framed content drop its own sandbox;
  // here it would also give the app a real origin, and with it localStorage,
  // cookies, and a reachable holi-vault://.
  render(<AppFrame appId="retro" />)
  expect(frameOf().getAttribute('sandbox')).toBe('allow-scripts')
})

test('ignores a message that did not come from the frame', async () => {
  render(<AppFrame appId="retro" />)
  // `event.origin` is the string "null" for an opaque origin, so it is useless
  // as identity. The source is what says who spoke.
  fromFrame({ id: '1', method: 'docs.list' }, window)
  await Promise.resolve()
  expect(docsMock).not.toHaveBeenCalled()
})

test('answers a docs.read with the value, addressed to the frame', async () => {
  render(<AppFrame appId="retro" />)
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  fromFrame({ id: 'r1', method: 'docs.read', params: { path: 'a.md' } })
  await waitFor(() => expect(post).toHaveBeenCalled())
  expect(readMock).toHaveBeenCalledWith({ remote: REMOTE, path: 'a.md' })
  expect(post.mock.calls[0]![0]).toEqual({ id: 'r1', ok: true, value: '# A' })
})

test('answers docs.list and tasks.list from the vault the frame is in', async () => {
  render(<AppFrame appId="retro" />)
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  fromFrame({ id: 'd', method: 'docs.list' })
  fromFrame({ id: 't', method: 'tasks.list' })
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  expect(docsMock).toHaveBeenCalledWith({ remote: REMOTE })
  expect(tasksMock).toHaveBeenCalledWith({ remote: REMOTE })
})

test('a refusal comes back as a value, not as a thrown error', async () => {
  readMock.mockRejectedValueOnce(new Error('FORBIDDEN'))
  render(<AppFrame appId="retro" />)
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  fromFrame({ id: 'r1', method: 'docs.read', params: { path: 'MEMORY.md' } })
  await waitFor(() => expect(post).toHaveBeenCalled())
  expect(post.mock.calls[0]![0]).toMatchObject({ id: 'r1', ok: false })
})

test('an unknown method is refused rather than ignored', async () => {
  render(<AppFrame appId="retro" />)
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  fromFrame({ id: 'x', method: 'docs.write', params: { path: 'a.md', text: 'no' } })
  await waitFor(() => expect(post).toHaveBeenCalled())
  expect(post.mock.calls[0]![0]).toMatchObject({ id: 'x', ok: false })
})

test('reload rebuilds the frame rather than reusing it', async () => {
  render(<AppFrame appId="retro" />)
  const before = frameOf()
  await userEvent.click(screen.getByRole('button', { name: /reload/i }))
  expect(frameOf()).not.toBe(before)
})

test('a deleted app leaves a tombstone, not a frame', async () => {
  withApps() // the app is gone — a teammate deleted it and the pull landed
  render(<AppFrame appId="retro" />)
  expect(document.querySelector('iframe')).toBeNull()
  expect(screen.getByText(/retro/)).toBeTruthy()
  expect(screen.getByText(/deleted/i)).toBeTruthy()
  // A tab that evaporates while you are looking at it reads as a crash, so
  // closing it is the user's move, not ours.
  await userEvent.click(screen.getByRole('button', { name: /close/i }))
  expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([])
})
