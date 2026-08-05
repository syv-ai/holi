/**
 * `holi-google`, for real: the generated script executed against a live ops
 * server.
 *
 * This is the one integration worth running rather than mocking. The script is
 * *generated shell*, so nothing else in the suite would catch a quoting bug —
 * and a mangled search query does not fail loudly, it silently searches for
 * something else.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GOOGLE_CLI_SCRIPT, installGoogleCli } from '../src/main/google/cli'
import { createGoogleOpsServer, type GoogleOpsServer } from '../src/main/google/ops-server'

const run = promisify(execFile)

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
    await expect(run(bin, ['send'], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('usage:'),
    })
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
  it('does not claim the grant is read-only — the wall is the missing subcommand', () => {
    expect(GOOGLE_CLI_SCRIPT).not.toMatch(/scopes are readonly|only read \(/)
    expect(GOOGLE_CLI_SCRIPT).toContain('gmail.modify')
  })
})
