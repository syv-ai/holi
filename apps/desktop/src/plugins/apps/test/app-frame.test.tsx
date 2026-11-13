/**
 * The frame a vault app runs in: the renderer half of the boundary.
 *
 * What these tests are about is identity and isolation, not rendering: the frame
 * must be sandboxed in the exact way that leaves its origin opaque, it must
 * answer only the frame it mounted, and it must pass the vault its own idea of
 * which app is speaking rather than the app's.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { appHost } from '../shared/bundle'
import { getDefaultStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act } from 'react'
import { fireEvent, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { activeRemoteAtom, snapshotAtom } from '@/plugin-api'
import { setTestColorScheme } from '@/test/vault-app-shell'
import { AppFrame } from '../renderer/app-frame'
import { appCodeGenerationsAtom, appOpensAtom } from '../renderer/apps'
import { appsRenderer } from '../renderer'
import { createAppCode } from '../main/code'
import { createAppGrants } from '../main/grants'
import { listFiles } from '../../../main/plugin-api'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PREVIEW_SETTLE_MS,
  previewRequestsAtom,
  previewVersionsAtom,
} from '../renderer/app-previews'
import { installFakeHoli, type FakeHoli } from '@/test/fake-holi'

const approvalCommit = vi.hoisted(() => ({
  sha: 'a'.repeat(40),
  author: 'Ada',
  date: '2026-01-01T00:00:00Z',
  login: null as string | null,
}))
const approvalStatus = vi.hoisted(() => ({
  needsApproval: false,
  lastChange: null as typeof approvalCommit | null,
}))
let fakeHoli: FakeHoli

/** Main's side of the app door, answering the way the registry would. */
const bridgeMock = vi.fn((input: { remote: string; method: string }): Promise<unknown> => {
  if (input.method === 'docs.read') return Promise.resolve('# A')
  if (input.method === 'docs.list') {
    return Promise.resolve([{ path: 'a.md', kind: 'note', updatedAt: '' }])
  }
  return Promise.resolve([])
})

vi.mock('../renderer/apps-cap', () => ({
  appsCap: {
    call: (remote: string, input: { method: string }) => bridgeMock({ remote, ...input }),
    // No `dangerously-allow` reads to approve, so the frame mounts at once.
    grants: (...args: unknown[]) => grantsMock(...args),
    grant: (...args: unknown[]) => grantMock(...args),
    capturePreview: (...args: unknown[]) => captureMock(...args),
    log: () => Promise.resolve(true),
  },
}))

const status = () => ({
  codeHash: 'h',
  expiresAt: null as number | null,
  affordances: approvalStatus.needsApproval ? [{ affordance: 'mail', granted: false }] : [],
  ...(approvalStatus.needsApproval
    ? { added: approvalCommit, lastChange: approvalStatus.lastChange }
    : {}),
})
const grantsMock = vi.fn((..._args: unknown[]) => Promise.resolve(status()))
const grantMock = vi.fn((..._args: unknown[]) => Promise.resolve(true))
const captureMock = vi.fn((..._args: unknown[]) => Promise.resolve({ saved: true }))

/** The tabs the tombstone's button closed, as `[surface, id]`. */
const closed = vi.hoisted(() => [] as [string, string][])
vi.mock('@/plugin-api', async (original) => ({
  ...(await original<typeof import('@/plugin-api')>()),
  closeSurfaceTabAtom: (await import('jotai')).atom(
    null,
    (_get, _set, surface: string, id: string) => {
      closed.push([surface, id])
    },
  ),
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
  grantsMock.mockReset().mockImplementation(() => Promise.resolve(status()))
  grantMock.mockReset().mockResolvedValue(true)
  captureMock.mockReset().mockResolvedValue({ saved: true })
  setTestColorScheme('dark')
  store.set(appOpensAtom, {})
  store.set(appCodeGenerationsAtom, {})
  store.set(previewRequestsAtom, {})
  store.set(previewVersionsAtom, {})
  approvalStatus.needsApproval = false
  approvalStatus.lastChange = null
  fakeHoli?.restore()
  fakeHoli = installFakeHoli((op) => {
    if (op.path === 'history.list') return []
    if (op.path === 'history.commit') {
      const { sha } = op.input as { sha: string }
      return { ...approvalCommit, sha, subject: 'create app', added: 1, removed: 0 }
    }
    if (op.path === 'github.fileContributors') return []
    return undefined
  })
  closed.length = 0
  withApps('Team/Retro.app')
})

const frameOf = () => document.querySelector('iframe')!

/** Mount the app and wait for its frame: the frame waits for main to say
 *  there is nothing to approve. */
async function renderApp() {
  render(<AppFrame path="Team/Retro.app" />)
  await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
}

test('approval authorship opens its exact history target outside the recent list', async () => {
  approvalStatus.needsApproval = true
  const user = userEvent.setup()
  render(<AppFrame path="Team/Retro.app" />)
  const commitLink = await screen.findByRole('button', { name: approvalCommit.sha.slice(0, 7) })
  await user.click(commitLink)
  await waitFor(() => expect(screen.getByRole('heading', { name: 'create app' })).toBeTruthy())
  expect(fakeHoli.calls).toContainEqual({
    path: 'history.commit',
    input: { sha: approvalCommit.sha },
  })
  await user.click(screen.getByRole('button', { name: /all commits/i }))
  expect(screen.getByRole('heading', { name: 'Commits' })).toBeTruthy()
})

test('approval Last changed by opens its exact history target', async () => {
  approvalStatus.needsApproval = true
  approvalStatus.lastChange = { ...approvalCommit, sha: 'c'.repeat(40), author: 'Bo' }
  const user = userEvent.setup()
  render(<AppFrame path="Team/Retro.app" />)
  const commitLink = await screen.findByRole('button', {
    name: approvalStatus.lastChange.sha.slice(0, 7),
  })
  await user.click(commitLink)
  await waitFor(() => expect(screen.getByRole('heading', { name: 'create app' })).toBeTruthy())
  expect(fakeHoli.calls).toContainEqual({
    path: 'history.commit',
    input: { sha: approvalStatus.lastChange.sha },
  })
})

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
  const sandbox = frameOf().getAttribute('sandbox')!.split(' ')
  expect(sandbox).toContain('allow-scripts')
  expect(sandbox).not.toContain('allow-same-origin')
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
  fromFrame({ id: 'x', method: 'docs.delete', params: { path: 'a.md' } })
  await waitFor(() => expect(post).toHaveBeenCalled())
  expect(post.mock.calls[0]![0]).toMatchObject({ id: 'x', ok: false })
  // Refused here, before main: a name that is not a bridge method never crosses.
  expect(bridgeMock).not.toHaveBeenCalled()
})

// The pane header's reload button and `holi apps open` both bump this count.
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
  expect(closed).toEqual([['app', 'Team/Retro.app']])
})

test("holi.open refuses a secret file and this machine's state, even when they exist", async () => {
  const files = ['.env', '.holi/state/bridge.json']
  store.set(snapshotAtom, (snapshot) => ({
    ...snapshot,
    files: [...snapshot.files, ...files.map((path) => ({ path, updatedAt: '' }))],
  }))
  await renderApp()
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  for (const [at, target] of files.entries()) {
    fromFrame({ id: `o${at}`, method: 'open', params: { target } })
    await waitFor(() => expect(post).toHaveBeenCalledTimes(at + 1))
    expect(post.mock.calls[at]![0]).toMatchObject({ id: `o${at}`, ok: false })
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function changeCode(file = 'index.html') {
  appsRenderer.events!['code-changed']!(
    { remote: REMOTE, payload: { bundle: 'Team/Retro.app', codeHash: `${file}-v2` } },
    store,
  )
}

const runningFrame = () =>
  document.querySelector<HTMLIFrameElement>('iframe[sandbox*="allow-scripts"]')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('hidden consent neither steals focus nor leaves a history portal open', async () => {
  approvalStatus.needsApproval = true
  const view = render(<AppFrame path="Team/Retro.app" visible={false} />)
  await screen.findByText(/wants permission/)
  expect(document.activeElement).toBe(document.body)
  view.rerender(<AppFrame path="Team/Retro.app" />)
  expect(document.activeElement).toBe(screen.getByRole('dialog'))
  await userEvent.click(screen.getByRole('button', { name: approvalCommit.sha.slice(0, 7) }))
  await screen.findByRole('heading', { name: 'create app' })
  view.rerender(<AppFrame path="Team/Retro.app" visible={false} />)
  expect(screen.queryByRole('heading', { name: 'create app' })).toBeNull()
  view.rerender(<AppFrame path="Team/Retro.app" />)
  expect(screen.queryByRole('heading', { name: 'create app' })).toBeNull()
})

test.each(['index.html', 'app.yaml'])(
  'a hidden %s edit removes executable code until consent is checked',
  async (file) => {
    const view = render(<AppFrame path="Team/Retro.app" />)
    await waitFor(() => expect(runningFrame()).not.toBeNull())
    const before = runningFrame()!
    view.rerender(<AppFrame path="Team/Retro.app" visible={false} />)
    const pending = deferred<ReturnType<typeof status>>()
    grantsMock.mockReturnValueOnce(pending.promise)
    act(() => changeCode(file))
    expect(before.isConnected).toBe(false)
    expect(runningFrame()).toBeNull()
    approvalStatus.needsApproval = true
    await act(async () => pending.resolve(status()))
    expect(runningFrame()).toBeNull()
    expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
    expect(document.activeElement).toBe(document.body)
    view.rerender(<AppFrame path="Team/Retro.app" />)
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(runningFrame()).not.toBeNull())
    expect(grantMock).not.toHaveBeenCalled()
    expect(runningFrame()).not.toBe(before)
  },
)

test('hidden record pushes continue without resetting the frame; log edits do not reload', async () => {
  const view = render(<AppFrame path="Team/Retro.app" />)
  await waitFor(() => expect(runningFrame()).not.toBeNull())
  const before = runningFrame()!
  const post = vi.spyOn(before.contentWindow!, 'postMessage')
  view.rerender(<AppFrame path="Team/Retro.app" visible={false} />)
  act(() =>
    store.set(snapshotAtom, (snapshot) => ({
      ...snapshot,
      files: [
        ...snapshot.files,
        { path: 'Team/Retro.app/data/items/a.json', updatedAt: 'v2' },
        { path: 'Team/Retro.app/log.local.txt', updatedAt: 'v2' },
      ],
    })),
  )
  expect(runningFrame()).toBe(before)
  expect(before).toHaveAttribute('aria-hidden', 'true')
  expect(before).toHaveAttribute('tabindex', '-1')
  expect(post).toHaveBeenCalledWith({ push: 'store:items' }, '*')
  expect(grantsMock).toHaveBeenCalledTimes(1)
})

for (const replacement of ['reload', 'path', 'remote', 'mode', 'code', 'dispose'] as const) {
  function replace(view: ReturnType<typeof render>) {
    act(() => {
      if (replacement === 'reload') store.set(appOpensAtom, { 'Team/Retro.app': 1 })
      if (replacement === 'path') view.rerender(<AppFrame path="Other.app" />)
      if (replacement === 'remote') store.set(activeRemoteAtom, 'other/vault')
      if (replacement === 'mode') setTestColorScheme('light')
      if (replacement === 'code') changeCode()
      if (replacement === 'dispose') view.unmount()
    })
  }

  test(`a stale grant check cannot revive a load after ${replacement}`, async () => {
    withApps('Team/Retro.app', 'Other.app')
    const pending = deferred<ReturnType<typeof status>>()
    grantsMock.mockReturnValueOnce(pending.promise)
    const view = render(<AppFrame path="Team/Retro.app" />)
    approvalStatus.needsApproval = true
    replace(view)
    if (replacement !== 'dispose') await screen.findByText(/wants permission/)
    await act(async () => pending.resolve({ ...status(), affordances: [] }))
    expect(runningFrame()).toBeNull()
  })

  test(`pending approval cannot open a replacement after ${replacement}`, async () => {
    withApps('Team/Retro.app', 'Other.app')
    approvalStatus.needsApproval = true
    const pending = deferred<boolean>()
    grantMock.mockReturnValueOnce(pending.promise)
    const view = render(<AppFrame path="Team/Retro.app" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Allow for 30 days' }))
    replace(view)
    if (replacement !== 'dispose') await screen.findByText(/wants permission/)
    await act(async () => pending.resolve(true))
    expect(runningFrame()).toBeNull()
    if (replacement !== 'dispose')
      expect(screen.getByRole('button', { name: 'Allow for 30 days' })).toBeTruthy()
  })

  test(`delayed bridge response cannot reach any document after ${replacement}`, async () => {
    withApps('Team/Retro.app', 'Other.app')
    const pending = deferred<unknown>()
    bridgeMock.mockReturnValueOnce(pending.promise)
    const view = render(<AppFrame path="Team/Retro.app" />)
    await waitFor(() => expect(runningFrame()).not.toBeNull())
    const old = runningFrame()!
    const oldPost = vi.spyOn(old.contentWindow!, 'postMessage')
    fromFrame({ id: 'late', method: 'docs.read', params: { path: 'a.md' } }, old.contentWindow)
    replace(view)
    if (replacement !== 'dispose') await waitFor(() => expect(runningFrame()).not.toBeNull())
    const newPost = runningFrame() ? vi.spyOn(runningFrame()!.contentWindow!, 'postMessage') : null
    oldPost.mockClear()
    newPost?.mockClear()
    await act(async () => pending.resolve('old vault data'))
    expect(oldPost).not.toHaveBeenCalled()
    if (newPost) expect(newPost).not.toHaveBeenCalled()
  })
}

test('a failed permission check recovers when main registers the apps capability', async () => {
  grantsMock.mockRejectedValueOnce(new Error('no such method'))
  render(<AppFrame path="Team/Retro.app" />)
  expect(await screen.findByText('Could not check app permissions.')).toBeTruthy()
  expect(runningFrame()).toBeNull()
  expect(document.querySelector('iframe')).toBeNull()

  act(() =>
    appsRenderer.events!['commands-changed']!({ remote: 'other/vault', payload: null }, store),
  )
  expect(grantsMock).toHaveBeenCalledTimes(1)

  act(() => appsRenderer.events!['commands-changed']!({ remote: REMOTE, payload: null }, store))
  await waitFor(() => expect(runningFrame()).not.toBeNull())
  expect(grantsMock).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('Could not check app permissions.')).toBeNull()
})

test('registration signal recovers a permission check that is still pending', async () => {
  const pending = deferred<ReturnType<typeof status>>()
  grantsMock.mockReturnValueOnce(pending.promise)
  render(<AppFrame path="Team/Retro.app" />)
  await waitFor(() => expect(grantsMock).toHaveBeenCalledTimes(1))

  act(() => appsRenderer.events!['commands-changed']!({ remote: REMOTE, payload: null }, store))
  await waitFor(() => expect(runningFrame()).not.toBeNull())
  expect(grantsMock).toHaveBeenCalledTimes(2)

  await act(async () => pending.reject(new Error('no such method')))
  expect(runningFrame()).not.toBeNull()
})

test('a refused grant rechecks the changed code instead of executing it', async () => {
  approvalStatus.needsApproval = true
  grantMock.mockResolvedValueOnce(false)
  render(<AppFrame path="Team/Retro.app" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Allow for 30 days' }))
  await screen.findByRole('button', { name: 'Allow for 30 days' })
  expect(runningFrame()).toBeNull()
  expect(grantsMock).toHaveBeenCalledTimes(2)
})

test('hidden previews are cancelled and resume only after display', async () => {
  const view = render(<AppFrame path="Team/Retro.app" />)
  await waitFor(() => expect(runningFrame()).not.toBeNull())
  const frame = runningFrame()!
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 400,
    bottom: 400,
    width: 400,
    height: 400,
  } as DOMRect)
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => frame })
  vi.useFakeTimers()
  fireEvent.load(frame)
  view.rerender(<AppFrame path="Team/Retro.app" visible={false} />)
  act(() => store.set(previewRequestsAtom, { 'Team/Retro.app': 1 }))
  await act(async () => vi.advanceTimersByTime(PREVIEW_SETTLE_MS + 100))
  expect(captureMock).not.toHaveBeenCalled()
  view.rerender(<AppFrame path="Team/Retro.app" />)
  await act(async () => vi.advanceTimersByTime(PREVIEW_SETTLE_MS + 100))
  expect(captureMock).toHaveBeenCalledTimes(1)
  expect(runningFrame()).toBe(frame)
  view.rerender(<AppFrame path="Team/Retro.app" visible={false} />)
  view.rerender(<AppFrame path="Team/Retro.app" />)
  await act(async () => vi.advanceTimersByTime(PREVIEW_SETTLE_MS + 100))
  expect(captureMock).toHaveBeenCalledTimes(1)
})

test.each(['hide', 'reload', 'path', 'remote', 'mode', 'code', 'dispose'] as const)(
  'stale load and preview responses are ignored after %s',
  async (replacement) => {
    withApps('Team/Retro.app', 'Other.app')
    const view = render(<AppFrame path="Team/Retro.app" />)
    await waitFor(() => expect(runningFrame()).not.toBeNull())
    const frame = runningFrame()!
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 400,
      width: 400,
      height: 400,
    } as DOMRect)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => frame })
    const pending = deferred<{ saved: boolean }>()
    captureMock.mockReturnValueOnce(pending.promise)
    vi.useFakeTimers()
    fireEvent.load(frame)
    await act(async () => vi.advanceTimersByTime(PREVIEW_SETTLE_MS + 100))
    expect(captureMock).toHaveBeenCalledTimes(1)
    act(() => {
      if (replacement === 'hide') view.rerender(<AppFrame path="Team/Retro.app" visible={false} />)
      if (replacement === 'reload') store.set(appOpensAtom, { 'Team/Retro.app': 1 })
      if (replacement === 'path') view.rerender(<AppFrame path="Other.app" />)
      if (replacement === 'remote') store.set(activeRemoteAtom, 'other/vault')
      if (replacement === 'mode') setTestColorScheme('light')
      if (replacement === 'code') changeCode()
      if (replacement === 'dispose') view.unmount()
    })
    await act(async () => pending.resolve({ saved: true }))
    // A detached old iframe's load must not schedule a picture of its successor.
    fireEvent.load(frame)
    await act(async () => vi.advanceTimersByTime(PREVIEW_SETTLE_MS + 100))
    expect(captureMock).toHaveBeenCalledTimes(1)
    expect(store.get(previewVersionsAtom)).toEqual({})
  },
)

// These clocks are sampled in test steps to exercise main's wall-clock
// deadlines, never to generate UI state during a render.
test('an approved retained load expires while hidden and asks again before running', async () => {
  const expiresAt = Date.now() + 10_000
  grantsMock.mockResolvedValueOnce({ ...status(), expiresAt, affordances: [] })
  const view = render(<AppFrame path="Team/Retro.app" />)
  await waitFor(() => expect(runningFrame()).not.toBeNull())
  const before = runningFrame()!
  view.rerender(<AppFrame path="Team/Retro.app" visible={false} />)
  approvalStatus.needsApproval = true
  vi.useFakeTimers()
  // Fake time starts after the expiry timer was scheduled; advance both the
  // real deadline and the timer through the platform clock seam.
  vi.setSystemTime(expiresAt)
  fireEvent.focus(window)
  await act(async () => {})
  expect(before.isConnected).toBe(false)
  expect(runningFrame()).toBeNull()
  expect(document.activeElement).toBe(document.body)
  expect(screen.getByText(/wants permission/)).toBeTruthy()
})

test('expiry timers rearm beyond the browser timer limit without refreshing early', async () => {
  vi.useFakeTimers()
  const duration = 30 * 24 * 60 * 60 * 1000
  grantsMock.mockResolvedValueOnce({ ...status(), expiresAt: Date.now() + duration })
  const view = render(<AppFrame path="Team/Retro.app" visible={false} />)
  await act(async () => {})
  const frame = runningFrame()!
  expect(frame).not.toBeNull()
  approvalStatus.needsApproval = true
  await act(async () => vi.advanceTimersByTime(2_147_483_647))
  expect(runningFrame()).toBe(frame)
  expect(grantsMock).toHaveBeenCalledTimes(1)
  await act(async () => vi.advanceTimersByTime(duration - 2_147_483_647))
  expect(frame.isConnected).toBe(false)
  expect(runningFrame()).toBeNull()
  expect(grantsMock).toHaveBeenCalledTimes(2)
  view.unmount()
})

test('code-change signals are vault-scoped and invalidate even a hash seen on an earlier visit', async () => {
  await renderApp()
  const first = runningFrame()!
  act(() =>
    appsRenderer.events!['code-changed']!(
      { remote: 'other/vault', payload: { bundle: 'Team/Retro.app', codeHash: 'seen' } },
      store,
    ),
  )
  expect(runningFrame()).toBe(first)
  act(() => changeCode())
  await waitFor(() => expect(runningFrame()).not.toBeNull())
  const second = runningFrame()!
  expect(second).not.toBe(first)
  act(() => changeCode())
  expect(second.isConnected).toBe(false)
  await waitFor(() => expect(runningFrame()).not.toBeNull())
  expect(runningFrame()).not.toBe(second)
})

test('a dependency-only scan invalidates a hidden approved frame through the real plugin signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-frame-code-'))
  const bundle = 'Team/Retro.app'
  const put = async (path: string, text: string) => {
    await mkdir(join(root, bundle, path, '..'), { recursive: true })
    await writeFile(join(root, bundle, path), text)
  }
  const signals: string[] = []
  const code = createAppCode(root, (path, codeHash) => {
    signals.push(codeHash)
    appsRenderer.events!['code-changed']!(
      { remote: REMOTE, payload: { bundle: path, codeHash } },
      store,
    )
  })
  try {
    await put('index.html', '<script src="node_modules/lib/index.js"></script>')
    await put('app.yaml', 'dangerously-allow: [mail]\n')
    await put('node_modules/lib/index.js', 'window.version = 1')
    const grants = createAppGrants(join(root, 'grants.json'), Date.now, code.read)
    const original = await grants.status(REMOTE, root, bundle)
    await grants.grant(REMOTE, root, bundle, ['mail'], original.codeHash)
    grantsMock.mockImplementation(async () => ({
      ...status(),
      ...(await grants.status(REMOTE, root, bundle)),
    }))
    // The vault scanner's real walk prunes dependencies before snapshot bucketing.
    const snapshot = {
      ...emptyVaultSnapshot(),
      files: (await listFiles(root)).map((path) => ({ path, updatedAt: '' })),
    }
    expect(snapshot.files.some((f) => f.path.includes('node_modules'))).toBe(false)
    act(() => store.set(snapshotAtom, snapshot))
    const view = render(<AppFrame path={bundle} />)
    await waitFor(() => expect(runningFrame()).not.toBeNull())
    const before = runningFrame()!
    view.rerender(<AppFrame path={bundle} visible={false} />)
    await put('data/items/a.json', '{}')
    await put('log.local.txt', 'one line')
    await act(async () => code.scan())
    expect(signals).toEqual([])
    expect(runningFrame()).toBe(before)
    await put('node_modules/lib/index.js', 'window.version = 2')
    // Exercise the same scanner used by watcher hints and onSnapshot healing.
    // No dependency is invented in the snapshot, and no renderer stamp changes.
    await act(async () => code.scan())
    expect(before.isConnected).toBe(false)
    expect(runningFrame()).toBeNull()
    await screen.findByText(/wants permission/)
    expect(signals.at(-1)).toBe((await grants.status(REMOTE, root, bundle)).codeHash)
    expect(signals.at(-1)).not.toBe(original.codeHash)
    expect(document.activeElement).toBe(document.body)
    view.rerender(<AppFrame path={bundle} />)
    expect(runningFrame()).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow for 30 days' })).toBeTruthy()
    view.unmount()
  } finally {
    await code.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('successful approval rereads main for expiry before executing the approved load', async () => {
  approvalStatus.needsApproval = true
  const pending = deferred<ReturnType<typeof status>>()
  render(<AppFrame path="Team/Retro.app" />)
  const allow = await screen.findByRole('button', { name: 'Allow for 30 days' })
  grantsMock.mockReturnValueOnce(pending.promise)
  await userEvent.click(allow)
  expect(runningFrame()).toBeNull()
  await act(async () =>
    pending.resolve({ ...status(), affordances: [], expiresAt: Date.now() + 1000 }),
  )
  expect(runningFrame()).not.toBeNull()
})
