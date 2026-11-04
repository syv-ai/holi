/**
 * The agent inbox's rules: a repeat raises nothing, banners are spaced, the
 * file stays bounded, and needs-you is an edge per session, not a level.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { VAULT_NOT_OPEN, type CapabilityContext } from '../../../main/plugin-api'
import type { SessionSummary } from '../main/claude/listing'
import { inboxCapabilities } from '../main/inbox/capabilities'
import { createInbox } from '../main/inbox/inbox'
import { watchNeedsYou } from '../main/inbox/needs-you'
import { workLogPath } from '../main/inbox/work-log'
import {
  admit,
  BANNER_GAP_MS,
  enteredNeedsYou,
  INBOX_CAP,
  parseInbox,
  REPEAT_MS,
  unreadCount,
  withEntry,
  type InboxEntry,
  type InboxFile,
} from '../main/inbox/rules'

const T0 = Date.parse('2026-10-21T09:00:00Z')
const notice = { title: 'Offer drafted', line: 'Check the prices.', path: 'tilbud/a.md' }
const entry = (at: number, extra: Partial<InboxEntry> = {}): InboxEntry => ({
  id: `e${at}`,
  at: new Date(at).toISOString(),
  ...notice,
  ...extra,
})
const file = (...entries: InboxEntry[]): InboxFile => ({ entries, seen: null })

describe('admit', () => {
  it('drops a repeat of an entry still in the inbox from the last few minutes', () => {
    expect(admit(file(entry(T0)), notice, T0 + REPEAT_MS - 1, null)).toEqual({ kind: 'repeat' })
    expect(admit(file(entry(T0)), notice, T0 + REPEAT_MS, null).kind).toBe('new')
    // Another line, or another target, is another notice.
    expect(admit(file(entry(T0)), { ...notice, line: 'Other' }, T0 + 1, null).kind).toBe('new')
    expect(admit(file(entry(T0)), { ...notice, path: undefined }, T0 + 1, null).kind).toBe('new')
  })

  it('spaces banners, so a burst lands in the inbox with one on screen', () => {
    expect(admit(file(), notice, T0, null)).toEqual({ kind: 'new', banner: true })
    expect(admit(file(), notice, T0 + BANNER_GAP_MS - 1, T0)).toEqual({
      kind: 'new',
      banner: false,
    })
    expect(admit(file(), notice, T0 + BANNER_GAP_MS, T0)).toEqual({ kind: 'new', banner: true })
  })
})

describe('the inbox file', () => {
  it('keeps the newest INBOX_CAP entries', () => {
    let f = file()
    for (let i = 0; i < INBOX_CAP + 5; i++) f = withEntry(f, entry(T0 + i))
    expect(f.entries).toHaveLength(INBOX_CAP)
    expect(f.entries[0]!.at).toBe(new Date(T0 + INBOX_CAP + 4).toISOString())
  })

  it('reads entry by entry, and caps what it reads', () => {
    const many = Array.from({ length: INBOX_CAP + 3 }, (_, i) => entry(T0 + i))
    const parsed = parseInbox({ entries: [{ title: 'no id' }, ...many], seen: 3 })
    expect(parsed.entries).toHaveLength(INBOX_CAP)
    expect(parsed.seen).toBeNull()
    expect(parseInbox('nonsense')).toEqual({ entries: [], seen: null })
  })

  it('counts what came after the person last looked', () => {
    const f = file(entry(T0 + 2), entry(T0 + 1), entry(T0))
    expect(unreadCount(f)).toBe(3)
    expect(unreadCount({ ...f, seen: new Date(T0 + 1).toISOString() })).toBe(1)
  })
})

describe('createInbox', () => {
  function harness(focused: boolean) {
    let stored = parseInbox(null)
    const banners: string[] = []
    let clock = T0
    const inbox = createInbox({
      store: {
        read: async () => stored,
        update: async (change) => (stored = await change(stored)),
      },
      notify: (n) => {
        if (focused) return false
        banners.push(n.title)
        return true
      },
      changed: () => {},
      open: () => {},
      now: () => new Date(clock),
    })
    return { inbox, banners, tick: (ms: number) => (clock += ms), stored: () => stored }
  }

  it('raises a banner, then only inbox entries until the gap has passed', async () => {
    const h = harness(false)
    expect(await h.inbox.raise({ title: 'A', line: '' })).toBe('banner')
    h.tick(1_000)
    expect(await h.inbox.raise({ title: 'B', line: '' })).toBe('inbox')
    expect(await h.inbox.raise({ title: 'B', line: '' })).toBe('repeat')
    h.tick(BANNER_GAP_MS)
    expect(await h.inbox.raise({ title: 'C', line: '' })).toBe('banner')
    expect(h.banners).toEqual(['A', 'C'])
    expect(h.stored().entries.map((e) => e.title)).toEqual(['C', 'B', 'A'])
  })

  it('keeps everything in the inbox while Holi has focus', async () => {
    const h = harness(true)
    expect(await h.inbox.raise({ title: 'A', line: '' })).toBe('inbox')
    h.tick(1_000)
    // No banner went up, so none holds the next one back.
    expect(await h.inbox.raise({ title: 'B', line: '' })).toBe('inbox')
    expect(h.banners).toEqual([])
  })
})

const session = (id: string, state: SessionSummary['state']): SessionSummary => ({
  id,
  provider: 'claude',
  name: `Session ${id}`,
  state,
})

describe('needs-you', () => {
  it('reports a session on its way into needs-you, once', () => {
    let step = enteredNeedsYou(new Set(), [session('a', 'working'), session('b', 'needs-you')])
    expect(step.entered.map((s) => s.id)).toEqual(['b'])
    step = enteredNeedsYou(step.waiting, [session('a', 'needs-you'), session('b', 'needs-you')])
    expect(step.entered.map((s) => s.id)).toEqual(['a'])
    // b answered, then asked again: a new edge.
    step = enteredNeedsYou(step.waiting, [session('a', 'needs-you'), session('b', 'working')])
    expect(step.entered).toEqual([])
    step = enteredNeedsYou(step.waiting, [session('a', 'needs-you'), session('b', 'needs-you')])
    expect(step.entered.map((s) => s.id)).toEqual(['b'])
  })

  function watcher(told: string[] = []) {
    let listener: (s: SessionSummary[]) => void = () => {}
    const raised: string[] = []
    const state = { focused: true }
    watchNeedsYou({
      sessions: {
        onSessions: (l) => {
          listener = l
          return () => {}
        },
        watched: (id) => id === 'shown',
      },
      focused: () => state.focused,
      told: async () => told,
      raise: async (n) => void raised.push(n.session!),
    })
    return { list: (s: SessionSummary[]) => listener(s), raised, state }
  }

  it('stays quiet about a session Holi shows while its window has focus', async () => {
    const w = watcher()
    w.list([session('shown', 'needs-you'), session('other', 'needs-you')])
    await vi.waitFor(() => expect(w.raised).toEqual(['other']))
    w.state.focused = false
    w.list([session('shown', 'working')])
    w.list([session('shown', 'needs-you')])
    await vi.waitFor(() => expect(w.raised).toEqual(['other', 'shown']))
  })

  it('does not tell again, after a restart, about a session the inbox already holds', async () => {
    const w = watcher(['old'])
    w.state.focused = false
    w.list([session('old', 'needs-you'), session('new', 'needs-you')])
    await vi.waitFor(() => expect(w.raised).toEqual(['new']))
    // Answered, then waiting again: that is news.
    w.list([session('old', 'working')])
    w.list([session('old', 'needs-you')])
    await vi.waitFor(() => expect(w.raised).toEqual(['new', 'old']))
  })
})

describe('holi agent notify', () => {
  const NOW = new Date(T0)

  async function notify(raw: Record<string, unknown>, live: boolean) {
    const root = await mkdtemp(join(tmpdir(), 'holi-inbox-'))
    const raised: unknown[] = []
    const caps = inboxCapabilities({
      inbox: {
        raise: async (n) => (raised.push(n), 'inbox'),
        view: async () => ({ entries: [], unread: 0 }),
        dismiss: async () => ({ entries: [], unread: 0 }),
        seen: async () => ({ entries: [], unread: 0 }),
      },
      liveRemote: () => (live ? 'syv-ai/notes' : null),
      now: () => NOW,
    })
    const ctx = {
      remote: 'syv-ai/notes',
      root,
      core: { syncState: () => (live ? {} : null) },
    } as unknown as CapabilityContext
    const cap = caps['agent.notify']
    try {
      const result = await cap.run(ctx, cap.params(raw))
      const log = await readFile(join(root, workLogPath(NOW)), 'utf8').catch(() => '')
      return { result, raised, log }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('takes only a job id as the session, never something a CLI reads as a flag', async () => {
    await expect(notify({ title: 'T', line: 'L', session: '--help' }, true)).rejects.toThrow()
    const ok = await notify({ title: 'T', line: 'L', session: '0a1b2c3d' }, true)
    expect(ok.raised).toEqual([{ title: 'T', line: 'L', session: '0a1b2c3d' }])
  })

  it('opens only a path a person may be shown: no machine state, no secret file', async () => {
    for (const path of ['.holi/state/bridge.local.json', '.HOLI/State/x.json', 'deploy/.env']) {
      await expect(notify({ title: 'T', line: 'L', path }, true)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    }
    const ok = await notify({ title: 'T', line: 'L', path: './notes/a.md' }, true)
    expect(ok.raised).toEqual([{ title: 'T', line: 'L', path: 'notes/a.md' }])
  })

  it('refuses, raising nothing, when Holi does not have the vault open', async () => {
    await expect(
      notify({ title: 'Offer drafted', line: 'Check it.' }, false),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', message: VAULT_NOT_OPEN })
  })
})
