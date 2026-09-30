/**
 * The frame a vault app runs in: the renderer half of the boundary.
 *
 * What these tests are about is identity and isolation, not rendering: the frame
 * must be sandboxed in the exact way that leaves its origin opaque, it must
 * answer only the frame it mounted, and it must pass the vault its own idea of
 * which app is speaking rather than the app's.
 */
import { appHost, emptyVaultSnapshot } from '@holi/shared'
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { act } from 'react'
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { AppFrame } from '../AppFrame'
import { snapshotAtom, activeRemoteAtom } from '../../../state/vaults'
import { appOpensAtom, workspaceAtom, openApp } from '../../../state/panes'

/** Main's side of the app door, answering the way the registry would. */
const bridgeMock = vi.fn((input: { method: string }): Promise<unknown> => {
  if (input.method === 'docs.read') return Promise.resolve('# A')
  if (input.method === 'docs.list') {
    return Promise.resolve([{ path: 'a.md', kind: 'note', updatedAt: '' }])
  }
  return Promise.resolve([])
})

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    apps: {
      bridge: { mutate: (input: { method: string }) => bridgeMock(input) },
      // No `dangerously-allow` reads to approve, so the frame mounts at once.
      grants: { query: () => Promise.resolve({ codeHash: 'h', affordances: [] }) },
    },
  },
}))

const REMOTE = 'syv-ai/1brain'
const store = getDefaultStore()

function withApps(...bundles: string[]) {
  store.set(activeRemoteAtom, REMOTE)
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    // Both files: registration is the manifest plus the entry document.
    files: bundles
      .flatMap((b) => [`${b}/index.html`, `${b}/app.yaml`])
      .map((path) => ({ path, updatedAt: '' })),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  withApps('Team/Retro.app')
  store.set(
    workspaceAtom,
    openApp({ panes: [{ tabs: [], active: -1 }], active: 0 }, 'Team/Retro.app'),
  )
})

const frameOf = () => document.querySelector('iframe')!

/** Mount the app and wait for its frame: the frame waits for main to say
 *  there is nothing to approve. */
async function renderApp() {
  render(<AppFrame path="Team/Retro.app" />)
  await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
}

/** A message as the frame itself would send it. */
function fromFrame(data: unknown, source: Window | null = frameOf().contentWindow) {
  window.dispatchEvent(new MessageEvent('message', { data, source }))
}

test('serves the app from its own origin, the host encoding its bundle', async () => {
  await renderApp()
  expect(frameOf().getAttribute('src')).toBe(
    `holi-app://${appHost('Team/Retro.app')}/index.html?mode=dark`,
  )
})

test('is sandboxed WITHOUT allow-same-origin', async () => {
  // The mail frame is the exact opposite (`allow-same-origin` and no scripts),
  // and the pair of tests is what says these two are deliberate opposites.
  // Granting both is the footgun that lets framed content drop its own sandbox;
  // here it would also give the app a real origin, and with it localStorage,
  // cookies, and a reachable holi-vault://.
  await renderApp()
  expect(frameOf().getAttribute('sandbox')).toBe('allow-scripts')
})

test('ignores a message that did not come from the frame', async () => {
  await renderApp()
  // `event.origin` is the string "null" for an opaque origin, so it is useless
  // as identity. The source is what says who spoke.
  fromFrame({ id: '1', method: 'docs.list' }, window)
  await Promise.resolve()
  expect(bridgeMock).not.toHaveBeenCalled()
})

test('answers a docs.read with the value, addressed to the frame', async () => {
  await renderApp()
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  fromFrame({ id: 'r1', method: 'docs.read', params: { path: 'a.md' } })
  await waitFor(() => expect(post).toHaveBeenCalled())
  // The bundle is the one this frame was mounted with: the app never names itself.
  expect(bridgeMock).toHaveBeenCalledWith({
    remote: REMOTE,
    bundle: 'Team/Retro.app',
    method: 'docs.read',
    params: { path: 'a.md' },
  })
  expect(post.mock.calls[0]![0]).toEqual({ id: 'r1', ok: true, value: '# A' })
})

test('answers docs.list and tasks.list from the vault the frame is in', async () => {
  await renderApp()
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  fromFrame({ id: 'd', method: 'docs.list' })
  fromFrame({ id: 't', method: 'tasks.list' })
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  for (const method of ['docs.list', 'tasks.list']) {
    expect(bridgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ remote: REMOTE, bundle: 'Team/Retro.app', method }),
    )
  }
})

test('a refusal comes back as a value, not as a thrown error', async () => {
  bridgeMock.mockRejectedValueOnce(new Error('FORBIDDEN'))
  await renderApp()
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  fromFrame({ id: 'r1', method: 'docs.read', params: { path: 'MEMORY.md' } })
  await waitFor(() => expect(post).toHaveBeenCalled())
  expect(post.mock.calls[0]![0]).toMatchObject({ id: 'r1', ok: false })
})

test('an unknown method is refused rather than ignored', async () => {
  await renderApp()
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  fromFrame({ id: 'x', method: 'docs.write', params: { path: 'a.md', text: 'no' } })
  await waitFor(() => expect(post).toHaveBeenCalled())
  expect(post.mock.calls[0]![0]).toMatchObject({ id: 'x', ok: false })
  // Refused here, before main: a name that is not a bridge method never crosses.
  expect(bridgeMock).not.toHaveBeenCalled()
})

// The pane header's reload button and `holi app open` both bump this count.
test('reload rebuilds the frame rather than reusing it', async () => {
  await renderApp()
  const before = frameOf()
  act(() =>
    store.set(appOpensAtom, (n) => ({ ...n, 'Team/Retro.app': (n['Team/Retro.app'] ?? 0) + 1 })),
  )
  await waitFor(() => {
    expect(document.querySelector('iframe')).not.toBeNull()
    expect(frameOf()).not.toBe(before)
  })
})

test('a deleted app leaves a tombstone, not a frame', async () => {
  withApps() // the app is gone — a teammate deleted it and the pull landed
  render(<AppFrame path="Team/Retro.app" />)
  expect(document.querySelector('iframe')).toBeNull()
  expect(screen.getByText(/Retro/)).toBeTruthy()
  expect(screen.getByText(/deleted/i)).toBeTruthy()
  // A tab that evaporates while you are looking at it reads as a crash, so
  // closing it is the user's move, not ours.
  await userEvent.click(screen.getByRole('button', { name: /close/i }))
  expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([])
})
