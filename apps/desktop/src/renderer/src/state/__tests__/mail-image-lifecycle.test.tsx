import { act, renderHook } from '@/test/render'
import { Provider, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { resolveVaultSettings } from '@holi/shared'
import { hostPluginVaults, installedPluginsAtom, enabledPluginsAtom } from '@/state/plugins'
import { activeVaultSettingsAtom, loadVaultSettingsAtom } from '../settings'
import { activeRemoteAtom, openedRemoteAtom } from '../vaults'
// This integration test installs real plugins to exercise consent and recording
// through the app's lifecycle host; production core remains plugin-free.
/* eslint-disable no-restricted-imports */
import { AGENT_INFO } from '../../../../plugins/agent/info'
import { TASKS_INFO } from '../../../../plugins/tasks/info'
import { GOOGLE_INFO } from '../../../../plugins/google/info'
import {
  useRemoteContent,
  useSetAllSenderImages,
} from '../../../../plugins/google/renderer/mail-images'
import { transcribeRenderer } from '../../../../plugins/transcribe/renderer/index'
import { startCapture } from '../../../../plugins/transcribe/renderer/audio/capture'
import {
  recorderAtom,
  startRecordingAtom,
  stopRecordingAtom,
} from '../../../../plugins/transcribe/renderer/recorder'
/* eslint-enable no-restricted-imports */

const read = vi.fn()
const run = vi.fn()
vi.mock('@/lib/trpc', () => ({
  trpc: {
    settings: { read: { query: () => read() } },
    cap: { run: { mutate: (input: unknown) => run(input) } },
  },
}))
vi.mock('../../../../plugins/transcribe/renderer/audio/capture', () => ({ startCapture: vi.fn() }))

const remote = 'team/vault'
const infos = [AGENT_INFO, TASKS_INFO, GOOGLE_INFO, transcribeRenderer.info]
function settings(allowed: boolean) {
  return resolveVaultSettings(
    {
      app: 'dailyNotes: false',
      appLocal: null,
      plugins: 'plugins:\n  transcribe: true',
      pluginsLocal: JSON.stringify({
        google: {
          imagesFromAllSenders: allowed,
          imageSenders: allowed ? ['friend@example.com'] : [],
          timeFormat: '12h',
        },
      }),
    },
    infos,
  )
}

test.each(['success', 'failure'] as const)(
  'consent refresh %s preserves explicit plugin enablement, its lifecycle and recording',
  async (outcome) => {
    const stopCapture = vi.fn(async () => {})
    vi.mocked(startCapture).mockResolvedValue({
      stop: stopCapture,
      sources: { microphone: true, system: false },
      problems: [],
    })
    run.mockReset().mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'meeting.start') return { meetingId: 'meeting-1' }
      if (name === 'meeting.key.status') return { ready: true }
      if (name === 'meeting.list' || name === 'meeting.profiles') return []
      return { ok: true }
    })
    read.mockReset().mockResolvedValue(settings(true))
    const store = createStore()
    store.set(activeRemoteAtom, remote)
    store.set(openedRemoteAtom, remote)
    await store.set(loadVaultSettingsAtom, { force: true })
    const undo = vi.fn()
    const vault = vi.fn((...args: Parameters<NonNullable<typeof transcribeRenderer.vault>>) => {
      const off = transcribeRenderer.vault!(...args)
      return () => {
        undo()
        off()
      }
    })
    store.set(installedPluginsAtom, [
      { info: AGENT_INFO },
      { info: TASKS_INFO },
      { info: GOOGLE_INFO },
      { ...transcribeRenderer, vault },
    ])
    const stopHost = hostPluginVaults(store)
    const view = renderHook(
      () => ({
        choice: useRemoteContent({ key: 'message', sender: 'friend@example.com' }),
        setAll: useSetAllSenderImages(),
      }),
      { wrapper: ({ children }) => <Provider store={store}>{children}</Provider> },
    )
    try {
      await act(() =>
        store.set(startRecordingAtom, {
          profileId: null,
          title: '',
          microphone: true,
          system: false,
        }),
      )
      expect(store.get(enabledPluginsAtom).has('transcribe')).toBe(true)
      expect(vault).toHaveBeenCalledOnce()
      expect(store.get(recorderAtom).phase).toBe('recording')
      expect(view.result.current.choice.allowed).toBe(true)
      let finish!: (value: ReturnType<typeof settings>) => void
      let fail!: (error: Error) => void
      read.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve
            fail = reject
          }),
      )
      let saving!: Promise<void>
      await act(async () => {
        // Observe rejection immediately, including in the failure case.
        saving = view.result.current.setAll(false)
        void saving.catch(() => {})
      })
      expect(view.result.current.choice.allowed).toBe(false)
      expect(store.get(enabledPluginsAtom).has('transcribe')).toBe(true)
      expect(store.get(activeVaultSettingsAtom)).toMatchObject({
        dailyNotes: false,
        pluginValues: { google: { timeFormat: '12h' } },
      })
      expect(undo).not.toHaveBeenCalled()
      expect(store.get(recorderAtom).phase).toBe('recording')
      expect(stopCapture).not.toHaveBeenCalled()
      await act(async () => {
        if (outcome === 'success') finish(settings(false))
        else fail(new Error('settings unavailable'))
        await saving.catch(() => {})
      })
      expect(view.result.current.choice.allowed).toBe(false)
      expect(view.result.current.choice.pending).toBe(false)
      expect(store.get(enabledPluginsAtom).has('transcribe')).toBe(true)
      expect(undo).not.toHaveBeenCalled()
      expect(vault).toHaveBeenCalledOnce()
      expect(store.get(recorderAtom).phase).toBe('recording')
      expect(stopCapture).not.toHaveBeenCalled()
      expect(run.mock.calls.some(([input]) => input.name === 'meeting.stop')).toBe(false)
      if (outcome === 'failure') {
        read.mockResolvedValue(settings(false))
        await act(() => store.set(loadVaultSettingsAtom, { force: true }))
        expect(view.result.current.choice.allowed).toBe(false)
      }
    } finally {
      view.unmount()
      await store.set(stopRecordingAtom)
      stopHost()
    }
  },
)
