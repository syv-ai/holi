import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createClaudeCli,
  parseBackgrounded,
  sessionName,
  type RunOptions,
} from '../main/claude/cli'
import { POSIX_STATUS_LINE } from '../main/claude/seed'
import {
  isLive,
  parseListing,
  readContextPercent,
  readModelName,
  summarise,
  watchConfigDir,
  type ClaudeRow,
} from '../main/claude/listing'

const ROOT = '/Users/ada/Holi/syv/vault'
const target = { root: ROOT, configDir: '/cfg/vault', binDir: '/holi/bin' }

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

describe('attributed Claude Code 2.1.319 fixture consumers', () => {
  it('exercises launch output, status fields, and consumed CLI argv', async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve(
          fileURLToPath(new URL('.', import.meta.url)),
          'fixtures/claude-compatibility/agents-2.1.319.json',
        ),
        'utf8',
      ),
    ) as {
      sourceVersion: string
      reference: string
      provenance: string
      launchOutput: string
      statusLineInput: unknown
      rows: unknown[]
    }
    expect(fixture).toMatchObject({ sourceVersion: '2.1.319', provenance: 'constructed' })
    expect(fixture.reference).toMatch(/Claude Code 2.1.319/)
    expect(parseBackgrounded(fixture.launchOutput)).toBe('1234abcd')
    expect(readModelName(fixture.statusLineInput)).toBe('Sonnet 4')
    expect(readContextPercent(fixture.statusLineInput)).toBe(43)

    const calls: string[][] = []
    const cli = createClaudeCli({
      resolveBin: () => '/fake/claude',
      run: async (_bin, args) => {
        calls.push(args)
        return fixture.launchOutput
      },
    })
    expect(
      await cli.startBg(target, {
        name: 'Compatibility run',
        prompt: 'Inspect',
        model: 'sonnet',
        allow: ['Read'],
        deny: ['Bash'],
        appendSystemPrompt: 'Rules',
        mcpConfig: '/tmp/mcp.json',
      }),
    ).toEqual({ ok: true, id: '1234abcd' })
    expect(calls[0]).toEqual([
      '--bg',
      '--model',
      'sonnet',
      '--append-system-prompt',
      'Rules',
      '--mcp-config=/tmp/mcp.json',
      '--allowedTools=Read',
      '--disallowedTools=Bash',
      '--name',
      'Compatibility run',
      '--',
      'Inspect',
    ])
  })
})

describe('shipped Claude turn signal hook', () => {
  it('sends turn edges, Claude pid, pending work, and session-channel data locally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-turn-hook-'))
    const received: Array<{ url: string; body: string }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        received.push({ url: request.url ?? '', body })
        response.statusCode = request.url?.startsWith('/turn/end') ? 200 : 204
        if (response.statusCode === 200) response.end(JSON.stringify({ tree: '0123456789abcdef' }))
        else response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No loopback server address')
    try {
      const vault = dir
      await mkdir(join(vault, '.holi/state'), { recursive: true })
      await writeFile(join(vault, '.holi/vault'), '')
      await writeFile(
        join(vault, '.holi/state/bridge.local.env'),
        `HOLI_BRIDGE_PORT=${address.port}\nHOLI_BRIDGE_TOKEN=abc123\n`,
      )
      const hook = resolve(
        fileURLToPath(new URL('.', import.meta.url)),
        '../main/claude/vault/shipped/.claude/hooks/turn-signal.mjs',
      )
      const run = (edge: string, input: unknown, extra: NodeJS.ProcessEnv = {}) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [hook, edge], {
            cwd: vault,
            env: {
              ...process.env,
              CLAUDE_JOB_DIR: join(vault, '.claude/jobs/1234abcd'),
              CLAUDE_PID: '7788',
              ...extra,
            },
            stdio: ['pipe', 'ignore', 'pipe'],
          })
          let stderr = ''
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            stderr += chunk
          })
          child.stdin.end(JSON.stringify(input))
          const timer = setTimeout(() => {
            child.kill()
            reject(new Error(`${edge} hook timed out`))
          }, 4000)
          child.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('close', (code) => {
            clearTimeout(timer)
            code === 0 ? resolve() : reject(new Error(`${edge} hook exited ${code}: ${stderr}`))
          })
        })
      await run('start', {})
      await run('end', { background_tasks: [{ id: 'pending' }], session_crons: [{}] })
      await run(
        'session',
        {},
        {
          CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/inbox.sock',
          CLAUDE_CODE_MESSAGING_TOKEN: 'inbox-secret',
        },
      )
      expect(received).toHaveLength(3)
      expect(received[0]?.url).toContain('/turn/start?t=abc123&job=1234abcd&pid=7788')
      expect(received[1]?.url).toContain('/turn/end?t=abc123&job=1234abcd&pending=2')
      expect(received[2]?.url).toContain('/session?t=abc123&job=1234abcd')
      expect(JSON.parse(received[2]!.body)).toEqual({
        socket: '/tmp/inbox.sock',
        token: 'inbox-secret',
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('shipped Claude statusline command', () => {
  it('emits current status fields to a bounded loopback bridge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-statusline-'))
    const requests: Array<{ url: string; body: string }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        requests.push({ url: request.url ?? '', body })
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No loopback server address')
    try {
      await mkdir(join(dir, '.holi/state'), { recursive: true })
      await writeFile(join(dir, '.holi/vault'), '')
      await writeFile(
        join(dir, '.holi/state/bridge.local.env'),
        `HOLI_BRIDGE_PORT=${address.port}\nHOLI_BRIDGE_TOKEN=abc123\n`,
      )
      const child = spawn('sh', ['-c', POSIX_STATUS_LINE], {
        cwd: dir,
        env: { ...process.env, CLAUDE_JOB_DIR: join(dir, '.claude/jobs/1234abcd') },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stdin.end(
        JSON.stringify({
          model: { display_name: 'Sonnet 4' },
          context_window: { used_percentage: 42.6 },
        }),
      )
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('statusline subprocess timed out')), 3000)
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          code === 0 ? resolve() : reject(new Error(`statusline exited ${code}`))
        })
      })
      await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 2500 })
      expect(stdout).toContain('Sonnet 4 · 43% context')
      expect(requests[0]).toMatchObject({
        url: '/statusline?t=abc123&job=1234abcd',
        body: expect.stringContaining('Sonnet 4'),
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('parseListing', () => {
  it('consumes the attributed constructed compatibility listing, including history', async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve(
          fileURLToPath(new URL('.', import.meta.url)),
          'fixtures/claude-compatibility/agents-2.1.319.json',
        ),
        'utf8',
      ),
    ) as { sourceVersion: string; provenance: string; rows: unknown[] }
    expect(fixture).toMatchObject({ sourceVersion: '2.1.319', provenance: 'constructed' })
    const rows = parseListing(listing(fixture.rows), '/fixture/vault')
    expect(rows.map((row) => row.id)).toEqual(['20c9f6e8', '7b1e0c42'])
    expect(isLive(rows[0]!)).toBe(true)
    expect(isLive(rows[1]!)).toBe(false)
  })

  it('reads a background row keyed by its job id', () => {
    expect(parseListing(listing([LIVE]), ROOT)).toEqual([
      {
        id: '20c9f6e8',
        sessionId: '20c9f6e8-567a-4741-be50-89368985fa5a',
        name: 'Fix the broken CSV import',
        pid: 4242,
        status: 'busy',
        state: 'working',
        startedAt: LIVE.startedAt,
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

  it('reads a finished row as `--all` prints it (2.1.319) as past', () => {
    const done = {
      cwd: ROOT,
      id: '7b1e0c42',
      kind: 'background',
      name: 'Tidy the inbox',
      sessionId: '7b1e0c42-1f3a-4c55-9d0e-2a6b8f1c3d47',
      startedAt: 1790627831838,
      state: 'done',
    }
    const [row] = parseListing(listing([done]), ROOT)
    expect(row).toMatchObject({ id: '7b1e0c42', state: 'done', sessionId: done.sessionId })
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
      ['agents', '--json', '--all'],
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

  it('lists finished sessions with --all, and without it on a Claude Code that refuses it', async () => {
    const calls: string[][] = []
    const cli = createClaudeCli({
      resolveBin: () => '/c',
      run: async (_bin, args) => {
        calls.push(args)
        if (args.includes('--all')) throw new Error("error: unknown option '--all'")
        return '[]'
      },
      log: () => {},
    })
    expect(await cli.list(target)).toBe('[]')
    expect(await cli.list(target)).toBe('[]')
    // Refused once, never asked again.
    expect(calls).toEqual([
      ['agents', '--json', '--all'],
      ['agents', '--json'],
      ['agents', '--json'],
    ])
  })

  it('answers a listing that fails for another reason with nothing, without retrying', async () => {
    const calls: string[][] = []
    const cli = createClaudeCli({
      resolveBin: () => '/c',
      run: async (_bin, args) => {
        calls.push(args)
        throw new Error('timed out')
      },
      log: () => {},
    })
    expect(await cli.list(target)).toBeNull()
    expect(calls).toEqual([['agents', '--json', '--all']])
  })

  it('starts a scheduled run or a Holi with its model, rules and who it is, a plain option ending the rules', async () => {
    const calls: string[][] = []
    const cli = createClaudeCli({
      resolveBin: () => '/c',
      run: async (_bin, args) => {
        calls.push(args)
        return 'backgrounded · 1234abcd · x\n'
      },
      log: () => {},
    })
    await cli.startBg(target, {
      name: 'Inbox · 10:30',
      prompt: 'Check mail.',
      model: 'sonnet',
      allow: ['Bash(holi google search:*)', 'Edit'],
      appendSystemPrompt: 'You are the Holi Proposal.',
    })
    // `--allowedTools` is variadic: each rule its own `=` argument, and the
    // name after them, so the prompt is never read as one more rule.
    await cli.startBg(target, { prompt: 'Check mail.', allow: ['Edit'] })
    expect(calls).toEqual([
      [
        '--bg',
        '--model',
        'sonnet',
        '--append-system-prompt',
        'You are the Holi Proposal.',
        '--allowedTools=Bash(holi google search:*)',
        '--allowedTools=Edit',
        '--name',
        'Inbox · 10:30',
        '--',
        'Check mail.',
      ],
      ['--bg', '--allowedTools=Edit', '--name', 'Scheduled run', '--', 'Check mail.'],
    ])
  })

  it('passes an MCP config as one `=` argument, before the name ends the options', async () => {
    const calls: string[][] = []
    const cli = createClaudeCli({
      resolveBin: () => '/c',
      run: async (_bin, args) => {
        calls.push(args)
        return 'backgrounded · 1234abcd · x\n'
      },
      log: () => {},
    })
    await cli.startBg(target, {
      name: 'Meeting · Planning',
      prompt: 'Begin.',
      allow: ['Bash(holi meeting:*)'],
      mcpConfig: '/Users/me/mcp.json',
    })
    expect(calls).toEqual([
      [
        '--bg',
        '--mcp-config=/Users/me/mcp.json',
        '--allowedTools=Bash(holi meeting:*)',
        '--name',
        'Meeting · Planning',
        '--',
        'Begin.',
      ],
    ])
  })

  it('passes each deny rule as its own `=` argument, a plain option ending them', async () => {
    const calls: string[][] = []
    const cli = createClaudeCli({
      resolveBin: () => '/c',
      run: async (_bin, args) => {
        calls.push(args)
        return 'backgrounded · 1234abcd · x\n'
      },
      log: () => {},
    })
    await cli.startBg(target, {
      name: 'Meeting · Planning',
      prompt: 'Begin.',
      allow: ['Bash(holi meeting:*)'],
      deny: ['Read', 'Read(//**)'],
    })
    await cli.startBg(target, { prompt: 'Begin.', deny: ['WebFetch'] })
    expect(calls).toEqual([
      [
        '--bg',
        '--allowedTools=Bash(holi meeting:*)',
        '--disallowedTools=Read',
        '--disallowedTools=Read(//**)',
        '--name',
        'Meeting · Planning',
        '--',
        'Begin.',
      ],
      ['--bg', '--disallowedTools=WebFetch', '--name', 'Scheduled run', '--', 'Begin.'],
    ])
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
