/**
 * Transcribe's main side (docs/features/meetings.md): the meeting engine
 * (chunks in, transcript, topics, minutes and tasks out), its scribe
 * session, the tasks sent from it, and this machine's meeting profiles.
 *
 * The scribe and the tasks sent are agent sessions (`agent.launch`,
 * `agent.message`), and a sent task is a task file (`tasks.create`): it
 * requires both, and
 * hears the agent's session list and turn ends (`ctx.hear`).
 *
 * The speech key is this machine's (`speech-key.ts`), so a key saved in one
 * vault's Meetings tab wakes every vault's waiting uploads.
 */
import { join } from 'node:path'
import {
  jsonFileStore,
  readVaultEnv,
  readVaultSettings,
  type MainPlugin,
} from '../../../main/plugin-api'
import { TRANSCRIBE_INFO } from '../info'
import { meetingCapabilities, MEETING_NAMESPACES } from './capabilities'
import { createMeetings } from './engine'
import { createProfiles, parseProfilesFile } from './profiles'
import type { Launched } from './scribe'
import { createSpeechKey } from './speech-key'
import { parseServiceFile } from './speech-service'
import { createSileroVad, dataUrlBytes } from './silero'
import SILERO_VAD from './assets/silero-vad.onnx?url&inline'
import { readVaultHead, removeVaultFiles, vaultFolderExists, writeVaultText } from './vault-write'

/** How long quitting, or turning the plugin off, waits for a recording to
 *  hand over its last audio. */
const DRAIN_MS = 15_000

/** Each running vault's engine, woken when the machine's speech key changes. */
const wakers = new Set<() => void>()

export const transcribeMain: MainPlugin = {
  info: TRANSCRIBE_INFO,
  async activate(ctx) {
    // This machine's, outside any vault: a profile names the MCP config and
    // models its sessions start with, which the agent must not choose.
    const profiles = createProfiles(
      jsonFileStore(join(ctx.userData, 'meeting-profiles.json'), parseProfilesFile),
    )
    // The keychain: Electron, loaded only when the plugin starts (after
    // `whenReady`), so the module stays importable under plain Node.
    const { speechKeyStore } = await import('./electron')
    const fetchImpl = (url: string, init: RequestInit) => fetch(url, init)
    const services = jsonFileStore(join(ctx.userData, 'speech-service.json'), parseServiceFile)
    const speechKey = createSpeechKey({
      store: speechKeyStore(ctx.userData),
      vaultEnv: () => readVaultEnv(ctx.root),
      service: () => services.read(),
      fetch: fetchImpl,
      changed: () => {
        for (const wake of wakers) wake()
      },
    })
    /** The vault's folders as last scanned. */
    let folders: readonly string[] = []
    const meetings = createMeetings({
      dir: join(ctx.userData, 'meetings'),
      remote: ctx.remote,
      root: ctx.root,
      profiles,
      fetch: fetchImpl,
      apiKey: (service) => speechKey.resolve(service),
      service: () => services.read(),
      writeFile: (rel, text, guard) => writeVaultText(ctx.root, rel, text, guard),
      folderExists: (rel) => vaultFolderExists(ctx.root, rel),
      removeFiles: (rels, folder) => removeVaultFiles(ctx.root, rels, folder),
      readHead: (rel) => readVaultHead(ctx.root, rel),
      folders: () => folders,
      emit: (name, payload) => ctx.emit(ctx.remote, name, payload),
      agent: {
        launch: async (args) => (await ctx.call('agent.launch', args)) as Launched,
        start: async (args) => (await ctx.call('agent.start', args)) as Launched,
        message: (session, text) => ctx.call('agent.message', { session, text }),
        reply: async (session) =>
          ((await ctx.call('agent.reply', { session })) as { output: string | null }).output,
        stop: (session) => ctx.call('agent.stop', { id: session }),
        createTask: async (args) => (await ctx.call('tasks.create', args)) as { path: string },
        updateTask: async ({ path, description }) => {
          await ctx.call('tasks.update', { path, patch: { description } })
        },
        // Refused like any call while the Holis plugin is off, and by the
        // Holis for one this machine has not approved.
        sendToHoli: async (args) => (await ctx.call('holis.send', args)) as { sessionId: string },
      },
      provider: async () => (await readVaultSettings(ctx.root)).agentProvider,
      // The activity log is what Holi did; what the transcript left out, and
      // why, is for diagnosis: main's console, the Logs tab at debug.
      log: (level, message) =>
        level === 'debug' ? console.debug(`[transcribe] ${message}`) : ctx.log(level, message),
      // The model is inlined into main's bundle, as seed binaries are.
      vad: createSileroVad({
        model: () => dataUrlBytes(SILERO_VAD),
        log: (level, message) => ctx.log(level, message),
      }),
    })
    // Each scan, the meetings find their folders again: renamed, moved or
    // deleted in the vault (`meetings.follow`).
    const unscanned = ctx.onSnapshot((snapshot) => {
      folders = snapshot.dirs
      void meetings.follow()
    })
    const wake = () => meetings.wake()
    wakers.add(wake)
    const unsessions = ctx.hear('agent', 'sessions', (list) => meetings.scribe.hearSessions(list))
    const unturns = ctx.hear('agent', 'turn-end', (p) => {
      const id = (p as { id?: unknown } | null)?.id
      if (typeof id === 'string') meetings.scribe.hearTurnEnd(id)
    })
    const unregister = ctx.register(
      MEETING_NAMESPACES,
      meetingCapabilities({
        meetings,
        profiles,
        speechKey,
        services,
        remote: ctx.remote,
        // Every vault's waiting uploads go again with the new service.
        serviceChanged: () => {
          for (const w of wakers) w()
        },
      }),
    )
    await meetings.load()
    // The list as it is now, for a meeting picked up from before: the
    // agent's news keeps it after.
    void ctx
      .call('agent.sessions', {})
      .then((list) => meetings.scribe.hearSessions(list))
      .catch(() => {})
    return async () => {
      // A meeting recording here hands over its last audio first: the
      // renderer stops it (the capture's last chunk, then every upload, then
      // the stop), and these capabilities stay until it has, or for
      // `DRAIN_MS` at most.
      ctx.emit(ctx.remote, 'stop-recording', null)
      await meetings.drain(DRAIN_MS)
      wakers.delete(wake)
      unscanned()
      unsessions()
      unturns()
      unregister()
      await meetings.dispose()
    }
  },
}
