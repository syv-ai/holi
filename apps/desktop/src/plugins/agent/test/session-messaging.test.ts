/**
 * The writer into a Claude Code session's inbox socket, against a real Unix
 * socket standing in for the session.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { postToSession } from '../main/claude/messaging'

let dir: string
let server: Server | null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-inbox-'))
  server = null
})

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server === null ? resolve() : server.close(() => resolve()),
  )
  await rm(dir, { recursive: true, force: true })
})

/** A session's inbox: hands back every connection's bytes once it closes. */
async function inbox(): Promise<{ socket: string; received: Promise<string> }> {
  const socket = join(dir, 's.sock')
  let deliver!: (bytes: string) => void
  const received = new Promise<string>((r) => (deliver = r))
  server = createServer((conn) => {
    let bytes = ''
    conn.on('data', (chunk) => (bytes += chunk.toString('utf8')))
    conn.on('end', () => deliver(bytes))
  })
  await new Promise<void>((resolve) => server!.listen(socket, resolve))
  return { socket, received }
}

describe('postToSession', () => {
  it('writes the auth line, then the one user line, and closes', async () => {
    const { socket, received } = await inbox()
    await postToSession({ socket, token: 'f00d' }, 'change the date\non "that"')
    expect(await received).toBe(
      '{"type":"auth","token":"f00d"}\n' +
        '{"type":"user","message":{"role":"user","content":"change the date\\non \\"that\\""}}\n',
    )
  })

  it('refuses clearly when the socket is gone', async () => {
    await expect(
      postToSession({ socket: join(dir, 'gone.sock'), token: 'f00d' }, 'hi'),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringMatching(/no longer/) })
  })
})
