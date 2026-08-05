/**
 * `holi-google`, for real: the generated script executed against a live ops
 * server.
 *
 * This is the one integration worth running rather than mocking. The script is
 * *generated shell*, so nothing else in the suite would catch a quoting bug —
 * and a mangled search query does not fail loudly, it silently searches for
 * something else.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GOOGLE_CLI_SCRIPT, installGoogleCli } from '../src/main/google/cli'
import { createGoogleOpsServer, type GoogleOpsServer } from '../src/main/google/ops-server'

const run = promisify(execFile)

/**
 * Run the script with a body on **stdin**.
 *
 * `execFile` has no `input` option — that belongs to the *Sync* variants — so
 * passing one silently does nothing, the child's stdin never closes, and curl
 * blocks forever on `@-`. Which is exactly how this was first written, and it
 * cost a 63-second test run to notice.
 */
function runWithInput(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; input: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }))
    child.stdin.end(options.input, 'utf8')
  })
}

let dir: string
let bin: string
let server: GoogleOpsServer
let env: NodeJS.ProcessEnv
const calls: [string, unknown][] = []

beforeEach(async () => {
  calls.length = 0
  dir = await mkdtemp(join(tmpdir(), 'holi-cli-'))
  bin = await installGoogleCli(dir)
  server = createGoogleOpsServer({
    agenda: async (w) => {
      calls.push(['agenda', w])
      return [{ id: 'e1', title: 'Q2 review' }]
    },
    threads: async (q) => {
      calls.push(['threads', q])
      return [{ id: 't1', subject: 'Budget' }]
    },
    thread: async (id) => {
      calls.push(['thread', id])
      return { id, messages: [] }
    },
    setRead: async (id, read) => void calls.push(['setRead', { id, read }]),
    star: async (id, on) => void calls.push(['star', { id, on }]),
    archive: async (id) => void calls.push(['archive', id]),
    trash: async (id) => void calls.push(['trash', id]),
    draft: async (mail) => {
      calls.push(['draft', mail])
      return { id: 'd-1' }
    },
    send: async (mail) => {
      calls.push(['send', mail])
      return { id: 'm-1' }
    },
    reply: async (threadId, body) => {
      calls.push(['reply', { threadId, body }])
      return { id: 'm-2' }
    },
    schedule: async (event) => {
      calls.push(['schedule', event])
      return { id: 'ev-1' }
    },
    reschedule: async (id, patch) => void calls.push(['reschedule', { id, patch }]),
    unschedule: async (id) => {
      calls.push(['unschedule', id])
      // One id is wired to refuse, so the CLI's error passthrough is covered
      // by the same live server as everything else.
      if (id === 'ev-boom') {
        throw new Error('"Q2 review" has attendees, so changing it would email them.')
      }
    },
  })
  await server.start()
  env = {
    ...process.env,
    HOLI_GOOGLE_PORT: String(server.port()),
    HOLI_GOOGLE_TOKEN: server.token(),
  }
})

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

describe('holi-google', () => {
  it('fetches the agenda and prints JSON', async () => {
    const { stdout } = await run(bin, ['agenda'], { env })

    expect(JSON.parse(stdout)).toEqual([{ id: 'e1', title: 'Q2 review' }])
    expect(calls[0]![0]).toBe('agenda')
  })

  it('passes an explicit window through', async () => {
    await run(bin, ['agenda', '2026-08-04T00:00:00Z', '2026-08-05T00:00:00Z'], { env })

    expect(calls[0]![1]).toEqual({
      timeMin: '2026-08-04T00:00:00Z',
      timeMax: '2026-08-05T00:00:00Z',
    })
  })

  it('keeps a quoted search query intact — spaces, quotes and colons', async () => {
    // The exact shape that hand-rolled percent-encoding mangles.
    const query = 'subject:"Q2 budget" from:a@b.c is:unread'

    const { stdout } = await run(bin, ['search', query], { env })

    expect(calls[0]).toEqual(['threads', query])
    expect(JSON.parse(stdout)).toEqual([{ id: 't1', subject: 'Budget' }])
  })

  it('treats an empty search as the inbox', async () => {
    await run(bin, ['search', ''], { env })
    expect(calls[0]).toEqual(['threads', ''])
  })

  it('reads a thread by id', async () => {
    await run(bin, ['read', 't1'], { env })
    expect(calls[0]).toEqual(['thread', 't1'])
  })

  it('says what to do when Holi is not running, rather than failing obscurely', async () => {
    await expect(
      run(bin, ['agenda'], { env: { ...process.env, HOLI_GOOGLE_PORT: '', HOLI_GOOGLE_TOKEN: '' } }),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/not running|not connected/) })
  })

  it('rejects an unknown subcommand with usage', async () => {
    // Was `send`, which is now a real subcommand (D70) — a test whose subject
    // became a feature stops testing what it was written for.
    await expect(run(bin, ['delete-everything'], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('usage:'),
    })
  })

  it('names send and reply in the usage as the ones that reach a person', async () => {
    const failure = await run(bin, ['delete-everything'], { env }).catch(
      (e: unknown) => e as { stderr: string },
    )

    expect(failure.stderr).toMatch(/reaches another person/)
    expect(failure.stderr).toMatch(/undoable/)
  })

  it('never receives a Google credential — only the loopback token', async () => {
    const { stdout } = await run(bin, ['agenda'], { env })
    expect(stdout).not.toMatch(/access_token|refresh_token|Bearer/)
  })

  // The header comment is a security claim in a file the user is invited to
  // read. It said "it can only read (the granted scopes are readonly)" for a
  // day after D68 made the Gmail grant `gmail.modify` — true when written, and
  // silently false afterwards. The same claim in SKILL.md is pinned by
  // `seed-content.test.ts`; this is its twin, so the pair cannot drift apart
  // again the next time the scopes move.
  it('does not claim the grant is read-only, nor that it cannot write', () => {
    expect(GOOGLE_CLI_SCRIPT).not.toMatch(/scopes are readonly|only read \(/)
    expect(GOOGLE_CLI_SCRIPT).not.toMatch(/no subcommand that writes|only reads/)
    // What is true now: send reaches a person and is confirmed every time.
    expect(GOOGLE_CLI_SCRIPT).toMatch(/asks the user every single time/)
  })
})

/**
 * The write subcommands (D70), through the real generated shell.
 *
 * Chosen for the ways `sh` mangles things rather than for coverage: a body
 * containing the characters a hand-rolled JSON encoder breaks on, and the flag
 * forms that decide direction (`--unread`, `--off`) where getting it backwards
 * answers 200 and does the opposite of what was asked.
 */
describe('holi-google writes', () => {
  it('marks read, and marks unread with the flag', async () => {
    await run(bin, ['mark-read', 't1'], { env })
    await run(bin, ['mark-read', 't1', '--unread'], { env })

    expect(calls).toEqual([
      ['setRead', { id: 't1', read: true }],
      ['setRead', { id: 't1', read: false }],
    ])
  })

  it('stars, and unstars with --off', async () => {
    await run(bin, ['star', 't1'], { env })
    await run(bin, ['star', 't1', '--off'], { env })

    expect(calls).toEqual([
      ['star', { id: 't1', on: true }],
      ['star', { id: 't1', on: false }],
    ])
  })

  it('archives and trashes by id', async () => {
    await run(bin, ['archive', 't1'], { env })
    await run(bin, ['trash', 't2'], { env })

    expect(calls).toEqual([
      ['archive', 't1'],
      ['trash', 't2'],
    ])
  })

  // The most valuable test in this file. A body with a quote, a dollar, a
  // backtick, a backslash and newlines is what breaks every hand-rolled
  // encoder, and the failure is silent — a different email goes out.
  it('carries a hostile multi-line body from stdin, byte for byte', async () => {
    const body = 'Hej Ada,\n\n"Q2" koster $1.500 — `ikke` 100%.\nSe \\ vedhæftet.\n\nMvh'

    await runWithInput(bin, ['send', '--to', 'ada@syv.ai', '--subject', 'Møde på tirsdag'], {
      env,
      input: body,
    })

    expect(calls).toEqual([['send', { to: ['ada@syv.ai'], subject: 'Møde på tirsdag', body }]])
  })

  it('drafts with cc and a thread', async () => {
    await runWithInput(
      bin,
      ['draft', '--to', 'ada@syv.ai', '--subject', 'Re: x', '--cc', 'bo@syv.ai', '--thread', 't1'],
      { env, input: 'Draft body.' },
    )

    expect(calls).toEqual([
      [
        'draft',
        {
          to: ['ada@syv.ai'],
          subject: 'Re: x',
          cc: ['bo@syv.ai'],
          threadId: 't1',
          body: 'Draft body.',
        },
      ],
    ])
  })

  it('replies with the body on stdin and nothing else to get wrong', async () => {
    await runWithInput(bin, ['reply', 't1'], { env, input: 'Ja tak.' })

    expect(calls).toEqual([['reply', { threadId: 't1', body: 'Ja tak.' }]])
  })

  it('schedules a timed block and an all-day one', async () => {
    await run(
      bin,
      ['schedule', '--title', 'Deep work', '--start', '2026-08-06T09:00:00Z', '--end', '2026-08-06T11:00:00Z'],
      { env },
    )
    await run(
      bin,
      ['schedule', '--title', 'Off', '--start', '2026-08-06', '--end', '2026-08-07', '--all-day'],
      { env },
    )

    expect(calls[0]).toEqual([
      'schedule',
      { title: 'Deep work', start: '2026-08-06T09:00:00Z', end: '2026-08-06T11:00:00Z' },
    ])
    expect(calls[1]).toEqual([
      'schedule',
      { title: 'Off', start: '2026-08-06', end: '2026-08-07', allDay: true },
    ])
  })

  it('reschedules and unschedules', async () => {
    await run(bin, ['reschedule', 'ev-1', '--start', '2026-08-06T10:00:00Z'], { env })
    await run(bin, ['unschedule', 'ev-2'], { env })

    expect(calls).toEqual([
      ['reschedule', { id: 'ev-1', patch: { start: '2026-08-06T10:00:00Z' } }],
      ['unschedule', 'ev-2'],
    ])
  })

  it('rejects an unknown option rather than silently sending without it', async () => {
    // --bcc is not supported. Ignoring it would send the mail anyway, minus the
    // recipient the caller asked for.
    const failure = await runWithInput(
      bin,
      ['send', '--to', 'ada@syv.ai', '--bcc', 'eve@evil.example'],
      { env, input: 'x' },
    )

    expect(failure.code).toBe(2)
    expect(failure.stderr).toContain('unknown option')
  })

  it('prints the refusal from Holi, rather than failing bare', async () => {
    // --fail-with-body is what makes this work: curl must exit non-zero AND
    // print what the server said, or the agent gets an exit code it cannot act on.
    const failure = await run(bin, ['unschedule', 'ev-boom'], { env }).catch(
      (e: unknown) => e as { stdout: string },
    )

    expect(failure.stdout).toContain('attendees')
  })
})
