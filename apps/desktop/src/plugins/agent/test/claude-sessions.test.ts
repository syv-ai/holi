import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createClaudeCli,
  parseBackgrounded,
  sessionName,
  type RunOptions,
} from '../main/claude/cli'
import {
  isLive,
  parseListing,
  summarise,
  watchConfigDir,
  type ClaudeRow,
} from '../main/claude/listing'

const ROOT = '/Users/ada/Holi/syv/vault'

/** A row as `claude agents --json` prints it (2.1.284). */
const LIVE = {
  pid: 4242,
  id: '20c9f6e8',
  cwd: ROOT,
  kind: 'background',
  startedAt: 1790627831838,
  sessionId: '20c9f6e8-567a-4741-be50-89368985fa5a',
  name: 'Fix the broken CSV import',
  status: 'busy',
  state: 'working',
}

const listing = (rows: unknown[]): string => JSON.stringify(rows, null, 2) + '\n'

describe('parseListing', () => {
  it('reads a background row keyed by its job id', () => {
    expect(parseListing(listing([LIVE]), ROOT)).toEqual([
      {
        id: '20c9f6e8',
        sessionId: '20c9f6e8-567a-4741-be50-89368985fa5a',
        name: 'Fix the broken CSV import',
        pid: 4242,
        status: 'busy',
        state: 'working',
      },
    ])
  })

  it('keeps a row under the root and drops one for another tree', () => {
    const under = { ...LIVE, id: 'aaaaaaaa', cwd: `${ROOT}/notes` }
    const sibling = { ...LIVE, id: 'bbbbbbbb', cwd: `${ROOT}-other` }
    expect(parseListing(listing([under, sibling]), ROOT).map((r) => r.id)).toEqual(['aaaaaaaa'])
  })

  it('drops interactive rows, which Holi never starts', () => {
    expect(parseListing(listing([{ ...LIVE, kind: 'interactive' }]), ROOT)).toEqual([])
  })

  it('keeps a row whose process has exited, without pid or status', () => {
    const { pid: _p, status: _s, ...exited } = LIVE
    const [row] = parseListing(listing([{ ...exited, state: 'stopped' }]), ROOT)
    expect(row?.pid).toBeUndefined()
    expect(row !== undefined && isLive(row)).toBe(false)
  })

  it('costs a malformed row that row only', () => {
    const rows = parseListing(listing([{ ...LIVE, id: 7 }, null, LIVE]), ROOT)
    expect(rows.map((r) => r.id)).toEqual(['20c9f6e8'])
  })

  it('answers nothing for a failed or garbled listing', () => {
    expect(parseListing(null, ROOT)).toEqual([])
    expect(parseListing('not json', ROOT)).toEqual([])
    expect(parseListing('{}', ROOT)).toEqual([])
  })
})

describe('summarise', () => {
  const row = (over: Partial<ClaudeRow>): ClaudeRow => ({ id: '20c9f6e8', name: 'CSV', ...over })
  const none = new Set<string>()

  it('says needs-you, with the reason, for a waiting session', () => {
    expect(
      summarise(row({ status: 'waiting', waitingFor: 'permission prompt' }), none),
    ).toMatchObject({ state: 'needs-you', waitingFor: 'permission prompt' })
  })

  it('says working for busy and shell', () => {
    expect(summarise(row({ status: 'busy' }), none).state).toBe('working')
    expect(summarise(row({ status: 'shell' }), none).state).toBe('working')
  })

  it('lets the hook bracket say working when the listing says idle', () => {
    expect(summarise(row({ status: 'idle' }), new Set(['20c9f6e8'])).state).toBe('working')
  })

  it('calls a session waiting for its first prompt idle, not needs-you', () => {
    // `claude --bg` with no prompt lists as `state: blocked`, `status: idle`.
    expect(summarise(row({ status: 'idle', state: 'blocked' }), none).state).toBe('idle')
  })

  it('shows an unnamed session, listed under its id, as New session', () => {
    expect(summarise(row({ name: '20c9f6e8' }), none).name).toBe('New session')
    expect(summarise(row({ name: '' }), none).name).toBe('New session')
  })
})

describe('claude-cli', () => {
  const target = { root: ROOT, configDir: '/cfg/vault', binDir: '/holi/bin' }

  it('parses the documented --bg line, colour codes and all', () => {
    expect(
      parseBackgrounded('backgrounded · \x1b[36maeea37bf\x1b[39m · lab\n  claude agents'),
    ).toBe('aeea37bf')
    expect(parseBackgrounded('something else')).toBeNull()
  })

  it('names from the first line only, capped', () => {
    expect(sessionName('Fix this\nand that')).toBe('Fix this')
    expect(sessionName('   ')).toBeNull()
    expect(sessionName('x'.repeat(80))?.length).toBe(60)
  })

  it('runs every command in the vault, on its config dir, with Holi first on PATH', async () => {
    const calls: Array<{ args: string[]; opts: RunOptions }> = []
    const cli = createClaudeCli({
      resolveBin: () => '/usr/local/bin/claude',
      run: async (_bin, args, opts) => {
        calls.push({ args, opts })
        return args[0] === '--bg' ? 'backgrounded · 1234abcd · x\n' : '[]'
      },
      log: () => {},
    })

    await cli.list(target)
    await cli.stop(target, '1234abcd')
    await cli.startBg(target, { name: 'Tidy\nthe inbox', prompt: 'go' })
    await cli.forkBg(target, 'uuid-1', 'Copy')

    expect(calls.map((c) => c.args)).toEqual([
      ['agents', '--json'],
      ['stop', '1234abcd'],
      ['--bg', '--name', 'Tidy', '--', 'go'],
      ['--bg', '--resume', 'uuid-1', '--fork-session', '--name', 'Copy'],
    ])
    for (const { opts } of calls) {
      expect(opts.cwd).toBe(ROOT)
      expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/cfg/vault')
      expect(opts.env.PATH?.split(':')[0]).toBe('/holi/bin')
    }
  })

  it('answers the new id, or why there is none', async () => {
    const ok = createClaudeCli({
      resolveBin: () => '/c',
      run: async () => 'backgrounded · 1234abcd · x\n',
    })
    expect(await ok.startBg(target, {})).toEqual({ ok: true, id: '1234abcd' })

    const silent = createClaudeCli({ resolveBin: () => '/c', run: async () => '', log: () => {} })
    expect((await silent.startBg(target, {})).ok).toBe(false)

    const failing = createClaudeCli({
      resolveBin: () => '/c',
      run: async () => {
        throw new Error('boom')
      },
      log: () => {},
    })
    expect(await failing.list(target)).toBeNull()
    expect(await failing.stop(target, 'x')).toEqual({ ok: false, message: 'boom' })
  })

  it('refuses without a binary', async () => {
    const cli = createClaudeCli({ resolveBin: () => null, log: () => {} })
    expect(await cli.list(target)).toBeNull()
    expect((await cli.startBg(target, {})).ok).toBe(false)
  })
})

describe('watchConfigDir', () => {
  const dirs: string[] = []

  /**
   * Wait until the watch is live, by changing `probe` until a change is seen.
   * `fs.watch` returns before macOS's FSEvents stream is running, and Node
   * offers no ready signal, so a change made at once can go unseen: under load
   * it often did. Checked before each write, so no probe is written after
   * the one that was seen.
   */
  async function untilLive(probe: string, onChange: ReturnType<typeof vi.fn>): Promise<void> {
    await vi.waitFor(
      async () => {
        if (onChange.mock.calls.length > 0) return
        await writeFile(probe, String(Date.now()))
        throw new Error('watch not live yet')
      },
      { timeout: 5_000, interval: 250 },
    )
    onChange.mockClear()
  }
  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  it('fires, debounced, on a change under jobs/ or sessions/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-claude-sessions-'))
    dirs.push(dir)
    await mkdir(join(dir, 'sessions'))
    await mkdir(join(dir, 'jobs', 'abcd1234'), { recursive: true })
    const onChange = vi.fn()
    const stop = watchConfigDir(dir, onChange, () => {})
    await untilLive(join(dir, 'sessions', 'probe.json'), onChange)

    await writeFile(join(dir, 'jobs', 'abcd1234', 'state.json'), '{}')
    await writeFile(join(dir, 'sessions', '42.json'), '{}')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_000 })
    stop()
  })

  it('takes a directory that appears later, and reports its arrival', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-claude-sessions-'))
    dirs.push(dir)
    await mkdir(join(dir, 'jobs'))
    const onChange = vi.fn()
    const stop = watchConfigDir(dir, onChange, () => {})
    await untilLive(join(dir, 'jobs', 'probe.json'), onChange)

    await mkdir(join(dir, 'sessions'))
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3_000 })
    stop()
  })
})
