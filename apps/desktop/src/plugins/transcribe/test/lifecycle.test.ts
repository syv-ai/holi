import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { cap, noParams, type MainPlugin } from '../../../main/plugin-api'
import { createPluginHost } from '../../../main/plugin-host/host'
import { transcribeMain } from '../main/index'
import { chunkWav } from './engine-helpers'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('no test keychain')
    },
    decryptString: () => {
      throw new Error('no test keychain')
    },
  },
}))

it.each(['stop', 'stopAll', 'settings', 'snapshot'] as const)(
  'accepts only final renderer audio through production dispatch while the real transcribe disposer waits on %s',
  async (method) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = await mkdtemp(join(tmpdir(), 'holi-573-repair3-meeting-'))
    const root = join(dir, 'vault')
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    const settings = join(root, '.holi/settings/plugins.yaml')
    await writeFile(settings, 'plugins:\n  transcribe: true\n')
    const registry = createCapabilityRegistry()
    let captureStop!: () => void
    const requestedStop = new Promise<void>((resolve) => {
      captureStop = resolve
    })
    const agent: MainPlugin = {
      info: { id: 'agent', label: 'Agent adapter', default: true },
      activate(ctx) {
        ctx.register(['agent'], {
          'agent.sessions': cap({ doors: ['ui'], params: noParams, run: async () => [] }),
          'agent.launch': cap({
            doors: ['ui'],
            params: (raw) => raw,
            run: async () => ({ ok: false, message: 'no test process' }),
          }),
          'agent.stop': cap({
            doors: ['ui'],
            params: (raw) => raw,
            run: async () => ({ ok: true }),
          }),
        })
        return () => {}
      },
    }
    const tasks: MainPlugin = { info: { id: 'tasks', label: 'Tasks adapter', default: true } }
    const vault = {
      remote: 'fixture/meeting',
      root,
      pause: () => {},
      resume: () => {},
      commitNow: async () => null,
      repo: { head: async () => 'head' },
    }
    const host = createPluginHost({
      plugins: [agent, tasks, transcribeMain],
      registry,
      userData: dir,
      coreSeeds: [],
      active: () => vault,
      rootFor: async () => root,
      events: {
        send: (_channel, event) => {
          if (event.name === 'stop-recording') captureStop()
        },
        listen: () => () => {},
        liveRemote: () => vault.remote,
      },
      openAppDoor: () => {
        throw new Error('no test app door')
      },
      route: () => () => {},
      binDir: () => dir,
      githubToken: () => null,
      frameOrigin: () => () => {},
      notify: () => false,
      focused: () => false,
      call: async (remote, name, params, beforeInvoke, finalization) =>
        (
          await capabilities.dispatch(
            { door: 'ui', remote, name, params, beforeInvoke },
            finalization,
          )
        ).value,
    })
    const capabilities = createCapabilityHost({
      registry,
      rootFor: async () => root,
      active: () => null,
      core: noCoreServices,
      pluginEnabled: async (plugin, at, allowDrain) =>
        (await host.serving(at, allowDrain)).has(plugin),
      claims: (at) => host.scanClaimsFor(at),
    })
    const call = async (name: string, params: unknown = {}) =>
      (await capabilities.dispatch({ door: 'ui', remote: vault.remote, name, params })).value
    let stopping: Promise<void> | undefined
    let meetingId: string | undefined
    try {
      await host.reconcile(vault, 'open')
      expect(host.failures(vault.remote)).toEqual({})
      meetingId = ((await call('meeting.start', { title: 'Final audio' })) as { meetingId: string })
        .meetingId
      if (method === 'settings' || method === 'snapshot') {
        await writeFile(settings, 'plugins:\n  transcribe: false\n')
        stopping = host.reconcile(vault, method)
      } else stopping = method === 'stop' ? host.stop(vault.remote) : host.stopAll()
      let drained = false
      void stopping.then(() => {
        drained = true
      })
      await requestedStop
      expect(drained).toBe(false)
      expect(registry.has('meeting.chunk', vault.remote)).toBe(true)
      await expect(call('meeting.start', { finalization: true })).rejects.toThrow('no such method')
      await expect(call('meeting.build', { finalization: true })).rejects.toThrow('no such method')
      const audio = Buffer.from(chunkWav(1, 'silent')).toString('base64')
      await call('meeting.chunk', { meetingId, n: 0, start: 0, duration: 1, audio })
      await call('meeting.chunk.lost', { meetingId, n: 1, start: 1, duration: 1 })
      expect(drained).toBe(false)
      await call('meeting.stop', { meetingId })
      await stopping
      expect(drained).toBe(true)
      const stored = JSON.parse(
        await readFile(join(dir, 'meetings', meetingId, 'state.json'), 'utf8'),
      )
      expect(stored.meeting.chunks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ n: 0 }),
          expect.objectContaining({ n: 1, state: 'failed', reason: 'lost' }),
        ]),
      )
      expect(stored.meeting.phase).not.toBe('recording')
      expect(registry.has('meeting.chunk', vault.remote)).toBe(false)
    } finally {
      // If an assertion fails, release the real recording drain without waiting
      // for its production deadline; no recording or timer outlives this test.
      await vi.advanceTimersByTimeAsync(15_000)
      await stopping?.catch(() => {})
      await host.stopAll()
      vi.clearAllTimers()
      vi.useRealTimers()
      await rm(dir, { recursive: true, force: true })
    }
  },
)
