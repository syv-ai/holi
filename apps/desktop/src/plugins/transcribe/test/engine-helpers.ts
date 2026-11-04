/**
 * A meeting engine over temporary folders, with fakes for the speech
 * service, the agent and the vault's writes. No network.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { AgentProviderId } from '@holi/shared'
import type { MeetingProfile, SpeechService } from '../shared/meeting'
import type { Fetch } from '../main/asr'
import { createMeetings } from '../main/engine'
import { DEFAULT_PROFILE, type Profiles } from '../main/profiles'
import type { Launched, LaunchArgs } from '../main/scribe'
import { encodeWav } from '../main/wav'

const RATE = 16_000
export const SCRIBE = 'abcd1234'

/** A stereo chunk with a tone on the microphone side, the computer side or
 *  neither. */
export function chunkWav(seconds: number, who: 'me' | 'them' | 'silent' = 'me'): Uint8Array {
  const left = new Int16Array(seconds * RATE)
  const right = new Int16Array(seconds * RATE)
  if (who !== 'silent') {
    const ch = who === 'me' ? left : right
    for (let i = 0; i < ch.length; i++) {
      ch[i] = Math.round(6000 * Math.sin((2 * Math.PI * 200 * i) / RATE))
    }
  }
  return encodeWav(RATE, [left, right])
}

/** The service: one segment per chunk, saying which call it was. */
function fakeService() {
  const forms: FormData[] = []
  const fetch = vi.fn<Fetch>(async (_url, init) => {
    forms.push(init.body as FormData)
    return Response.json({
      text: `said ${forms.length}`,
      segments: [{ start: 0.5, end: 2.5, text: `said ${forms.length}` }],
    })
  })
  return { fetch, forms }
}

/** Advance fake time in small steps, letting real I/O run between them,
 *  until `done` holds. */
export async function until(
  done: () => boolean | Promise<boolean>,
  maxMs = 120_000,
): Promise<void> {
  for (let waited = 0; waited <= maxMs; waited += 50) {
    if (await done()) return
    await vi.advanceTimersByTimeAsync(50)
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('timed out waiting')
}

/** What each fake vault holds, by its root. */
const vaults = new Map<string, Map<string, string>>()

export async function engineRig(
  opts: {
    profile?: Partial<MeetingProfile>
    /** This machine's profiles; else every id reads as `profile`. */
    profiles?: Pick<Profiles, 'get' | 'list'>
    fetch?: Fetch
    launch?: (args: LaunchArgs) => Promise<Launched>
    message?: (session: string, text: string) => Promise<unknown>
    /** What a Pi scribe's last turn answered. */
    reply?: (session: string) => Promise<string | null>
    userData?: string
    root?: string
    /** The speech key in use; `test-key` unless given. */
    apiKey?: (service: SpeechService) => Promise<string | null>
    /** The speech service; syv.ai's unless given. */
    service?: () => Promise<SpeechService>
    /** The vault's agent; Claude Code unless given. */
    provider?: () => Promise<AgentProviderId>
  } = {},
) {
  const userData = opts.userData ?? (await mkdtemp(join(tmpdir(), 'holi-meetings-')))
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), 'holi-vault-')))
  const profile: MeetingProfile = { ...DEFAULT_PROFILE, ...opts.profile }
  const service = fakeService()
  // One fake vault per root: an engine opened again on it finds what the
  // last one wrote, as it would on disk.
  const writes = vaults.get(root) ?? new Map<string, string>()
  vaults.set(root, writes)
  const removed: Array<{ rels: string[]; folder: string }> = []
  const emitted: Array<[string, unknown, number]> = []
  const agent = {
    launch: vi.fn<(args: LaunchArgs) => Promise<Launched>>(
      opts.launch ?? (async () => ({ ok: false, message: 'no agent here' })),
    ),
    message: vi.fn<(session: string, text: string) => Promise<unknown>>(
      opts.message ?? (async () => ({ ok: true })),
    ),
    reply: vi.fn<(session: string) => Promise<string | null>>(opts.reply ?? (async () => null)),
    stop: vi.fn(async (_session: string) => ({ ok: true })),
    createTask: vi.fn(
      async ({ title, folder }: { title: string; folder: string; description?: string }) => ({
        path: `${folder}/task.${title.toLowerCase().replace(/\W+/g, '-')}.local.md`,
      }),
    ),
    updateTask: vi.fn(async (_args: { path: string; description: string }) => {}),
    sendToHoli: vi.fn(async (_args: { holi: string; path: string }) => ({ sessionId: 'h0l1h0l1' })),
    start: vi.fn<
      (args: { name: string; prompt: string; provider: AgentProviderId }) => Promise<Launched>
    >(async () => ({ ok: true, sessionId: 'c0dex000' })),
  }
  const meetings = createMeetings({
    dir: join(userData, 'meetings'),
    remote: 'syv/vault',
    root,
    profiles: opts.profiles ?? { get: async () => profile, list: async () => [profile] },
    fetch: opts.fetch ?? service.fetch,
    apiKey: opts.apiKey ?? (async () => 'test-key'),
    service: opts.service ?? (async () => ({ url: null, model: null })),
    provider: opts.provider ?? (async () => 'claude'),
    writeFile: async (rel, text, guard) => {
      if (guard !== undefined && !(await guard())) return false
      writes.set(rel, text)
      return true
    },
    removeFiles: async (rels, folder) => {
      for (const rel of rels) writes.delete(rel)
      removed.push({ rels: [...rels], folder })
    },
    // The vault is what was written: its files, and the folders they are in.
    // Cut by bytes, as the real one reads them.
    readHead: async (rel) => {
      const text = writes.get(rel)
      return text === undefined
        ? null
        : new TextDecoder().decode(new TextEncoder().encode(text).slice(0, 256))
    },
    folderExists: async (rel) => [...writes.keys()].some((k) => k.startsWith(`${rel}/`)),
    folders: () => [
      ...new Set(
        [...writes.keys()].flatMap((rel) =>
          rel
            .split('/')
            .slice(0, -1)
            .map((_, k, parts) => parts.slice(0, k + 1).join('/')),
        ),
      ),
    ],
    emit: (name, payload) => emitted.push([name, structuredClone(payload), Date.now()]),
    agent,
    log: () => {},
  })
  await meetings.load()
  return { meetings, userData, root, profile, service, writes, removed, emitted, agent }
}

/** Let real I/O already started run out. */
export async function settle(): Promise<void> {
  for (let k = 0; k < 20; k++) await new Promise((resolve) => setImmediate(resolve))
}

/** Let real I/O run, without moving fake time, until `done` holds. */
export async function settleUntil(done: () => boolean): Promise<void> {
  for (let k = 0; k < 10_000; k++) {
    if (done()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('timed out waiting')
}
