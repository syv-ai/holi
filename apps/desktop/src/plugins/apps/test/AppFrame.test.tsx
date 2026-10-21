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
import { beforeEach, expect, test, vi } from 'vitest'
import { act } from 'react'
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { activeRemoteAtom, snapshotAtom } from '@/plugin-api'
import { AppFrame } from '../renderer/AppFrame'
import { appOpensAtom } from '../renderer/apps'
import { openTarget } from '../renderer/bridge-host'

/** Main's side of the app door, answering the way the registry would. */
const bridgeMock = vi.fn((input: { remote: string; method: string }): Promise<unknown> => {
  if (input.method === 'docs.read') return Promise.resolve('# A')
  if (input.method === 'docs.list') {
    return Promise.resolve([{ path: 'a.md', kind: 'note', updatedAt: '' }])
  }
  return Promise.resolve([])
})

/** Main's approvals. By default no `dangerously-allow` reads to approve, so
 *  the frame mounts at once. */
const grantsMock = vi.fn(
  (): Promise<{
    codeHash: string
    affordances: { affordance: string; granted: boolean }[]
    hosts?: string[]
  }> => Promise.resolve({ codeHash: 'h', affordances: [] }),
)

vi.mock('../renderer/apps-cap', () => ({
  appsCap: {
    call: (remote: string, input: { method: string }) => bridgeMock({ remote, ...input }),
    grants: () => grantsMock(),
    log: () => Promise.resolve(true),
  },
}))

/** The audio a recording hands back, and the recorder that "records" it. */
const AUDIO = vi.hoisted(() => ({ audio: 'bytes' }))
const startRecordingMock = vi.hoisted(() =>
  vi.fn((_params: unknown) =>
    Promise.resolve({
      level: () => 0.5,
      spectrum: () => [0.25],
      stop: () => Promise.resolve(AUDIO),
      discard() {},
    }),
  ),
)
vi.mock('../renderer/recorder', () => ({ startRecording: startRecordingMock }))

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

test('may not record until recording is granted', async () => {
  await renderApp()
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  fromFrame({ id: 'r', method: 'record.start' })
  await waitFor(() => expect(post).toHaveBeenCalled())
  expect(post.mock.calls[0]![0]).toMatchObject({ id: 'r', ok: false })
  expect(startRecordingMock).not.toHaveBeenCalled()
})

test('records for a granted app here, never in the frame, and hands back the audio', async () => {
  grantsMock.mockResolvedValueOnce({
    codeHash: 'h',
    affordances: [{ affordance: 'recording', granted: true }],
  })
  await renderApp()
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  const replies = (): unknown[] =>
    post.mock.calls.map((c) => c[0]).filter((m) => (m as { id?: string }).id !== undefined)
  fromFrame({ id: 's', method: 'record.start', params: { system: false } })
  await waitFor(() => expect(replies()).toHaveLength(1))
  expect(startRecordingMock).toHaveBeenCalledWith({ system: false })
  fromFrame({ id: 'e', method: 'record.stop' })
  await waitFor(() => expect(replies()).toHaveLength(2))
  expect(replies()[1]).toEqual({ id: 'e', ok: true, value: AUDIO })
  // Neither ever reached main.
  expect(bridgeMock).not.toHaveBeenCalled()
})

/** A recording whose start waits until the test lets it through, as one does
 *  while the system asks the person for the microphone. */
function slowRecording() {
  const discard = vi.fn()
  let letThrough = (): void => {}
  startRecordingMock.mockImplementationOnce(
    () =>
      new Promise((done) => {
        letThrough = () =>
          done({
            level: () => 0.5,
            spectrum: () => [0.25],
            stop: () => Promise.resolve(AUDIO),
            discard,
          })
      }),
  )
  return { discard, letThrough: () => letThrough() }
}

const grantRecording = () =>
  grantsMock.mockResolvedValueOnce({
    codeHash: 'h',
    affordances: [{ affordance: 'recording', granted: true }],
  })

test('refuses a second record.start while the first is still asking', async () => {
  grantRecording()
  const slow = slowRecording()
  await renderApp()
  const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
  const reply = (id: string) =>
    post.mock.calls.map((c) => c[0]).find((m) => (m as { id?: string }).id === id)
  fromFrame({ id: 'a', method: 'record.start' })
  fromFrame({ id: 'b', method: 'record.start' })
  await waitFor(() => expect(reply('b')).toMatchObject({ ok: false, error: 'already recording' }))
  slow.letThrough()
  await waitFor(() => expect(reply('a')).toMatchObject({ ok: true }))
  // One capture, not two: the second never reached the microphone.
  expect(startRecordingMock).toHaveBeenCalledTimes(1)
  expect(slow.discard).not.toHaveBeenCalled()
})

test('lets go of a capture whose document went away while it started', async () => {
  grantRecording()
  const slow = slowRecording()
  await renderApp()
  fromFrame({ id: 'a', method: 'record.start' })
  await waitFor(() => expect(startRecordingMock).toHaveBeenCalledTimes(1))
  // A reload while the system is still asking for the microphone.
  act(() =>
    store.set(appOpensAtom, (n) => ({ ...n, 'Team/Retro.app': (n['Team/Retro.app'] ?? 0) + 1 })),
  )
  slow.letThrough()
  // Nobody holds it, so it is let go rather than left recording.
  await waitFor(() => expect(slow.discard).toHaveBeenCalled())
})

test('the approval names the sites network would let the app reach', async () => {
  grantsMock.mockResolvedValueOnce({
    codeHash: 'h',
    affordances: [{ affordance: 'network', granted: false }],
    hosts: ['api.example.com', 'uploads.example.com'],
  })
  render(<AppFrame path="Team/Retro.app" />)
  expect(await screen.findByText(/wants permission to send requests to other sites/)).toBeTruthy()
  expect(screen.getByText('api.example.com')).toBeTruthy()
  expect(screen.getByText('uploads.example.com')).toBeTruthy()
  // Not the mail wording: network reads nothing of its own.
  expect(screen.queryByText(/What it reads/)).toBeNull()
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

test('pushes the recording level to the frame while recording, and stops after', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    grantsMock.mockResolvedValueOnce({
      codeHash: 'h',
      affordances: [{ affordance: 'recording', granted: true }],
    })
    await renderApp()
    const post = vi.spyOn(frameOf().contentWindow!, 'postMessage')
    fromFrame({ id: 's', method: 'record.start' })
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(120)
    expect(post).toHaveBeenCalledWith({ push: 'record:level', value: 0.5 }, '*')
    fromFrame({ id: 'e', method: 'record.stop' })
    await waitFor(() =>
      expect(post.mock.calls.some((c) => (c[0] as { id?: string }).id === 'e')).toBe(true),
    )
    const sent = post.mock.calls.length
    await vi.advanceTimersByTimeAsync(200)
    expect(post.mock.calls.length).toBe(sent)
  } finally {
    vi.useRealTimers()
  }
})

test("holi.open refuses a secret file and this machine's state, even when they exist", () => {
  const files = ['.env', '.holi/state/bridge.json']
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    files: files.map((path) => ({ path, updatedAt: '' })),
  })
  for (const target of files) {
    expect(() => openTarget(store, { target })).toThrow(`may not open ${target}`)
  }
})
