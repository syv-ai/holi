/**
 * The writer into a Claude Code session's inbox socket, against a real Unix
 * socket standing in for the session.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { postToSession, postToSessionWithSocketFactory } from '../main/claude/messaging'

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

class HeldSocket extends EventEmitter {
  destroyed = false
  writes: string[] = []
  end(data?: string): this {
    if (data !== undefined) this.writes.push(data)
    return this
  }
  destroy(): this {
    this.destroyed = true
    return this
  }
  close(): void {
    this.emit('close')
  }
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

  it('does not create a socket for a pre-aborted message', async () => {
    const controller = new AbortController()
    controller.abort()
    let created = false
    await expect(
      postToSessionWithSocketFactory(
        { socket: 'unused', token: 'f00d' },
        'hi',
        100,
        controller.signal,
        () => {
          created = true
          return new HeldSocket() as unknown as Socket
        },
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(created).toBe(false)
  })

  it('aborts before connect without writing bytes and waits for close', async () => {
    const controller = new AbortController()
    const socket = new HeldSocket()
    const result = postToSessionWithSocketFactory(
      { socket: 'held', token: 'secret-token' },
      'hi',
      1_000,
      controller.signal,
      () => socket as unknown as Socket,
    )
    controller.abort()
    expect(socket.destroyed).toBe(true)
    let settled = false
    void result.catch(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(socket.writes).toEqual([])
    socket.close()
    await expect(result).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('waits for physical close after writing and does not expose the token', async () => {
    const socket = new HeldSocket()
    const result = postToSessionWithSocketFactory(
      { socket: 'held', token: 'secret-token' },
      'hi',
      1_000,
      undefined,
      () => socket as unknown as Socket,
    )
    socket.emit('connect')
    expect(socket.writes).toEqual([
      '{"type":"auth","token":"secret-token"}\n{"type":"user","message":{"role":"user","content":"hi"}}\n',
    ])
    let settled = false
    void result.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    socket.close()
    await expect(result).resolves.toBeUndefined()
    socket.emit('error', Object.assign(new Error('secret-token'), { code: 'EIO' }))
  })

  it('cancels after writing without claiming the message was undelivered', async () => {
    const controller = new AbortController()
    const socket = new HeldSocket()
    const result = postToSessionWithSocketFactory(
      { socket: 'held', token: 'secret-token' },
      'hi',
      1_000,
      controller.signal,
      () => socket as unknown as Socket,
    )
    socket.emit('connect')
    controller.abort()
    expect(socket.destroyed).toBe(true)
    expect(socket.writes).toHaveLength(1)
    let settled = false
    void result.catch(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    socket.close()
    await expect(result).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.stringMatching(/uncertain/),
    })
  })

  it('joins timeout and socket errors with physical close', async () => {
    for (const fail of [
      (socket: HeldSocket) =>
        socket.emit('error', Object.assign(new Error('secret-token'), { code: 'EIO' })),
      () => undefined,
    ]) {
      const socket = new HeldSocket()
      const result = postToSessionWithSocketFactory(
        { socket: 'held', token: 'secret-token' },
        'hi',
        5,
        undefined,
        () => socket as unknown as Socket,
      )
      fail(socket)
      if (!socket.destroyed) await new Promise((resolve) => setTimeout(resolve, 15))
      expect(socket.destroyed).toBe(true)
      let settled = false
      void result.catch(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      socket.close()
      await expect(result).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    }
  })

  it('rejects a premature close and settles repeated close only once', async () => {
    const socket = new HeldSocket()
    const result = postToSessionWithSocketFactory(
      { socket: 'held', token: 'secret-token' },
      'hi',
      1_000,
      undefined,
      () => socket as unknown as Socket,
    )
    socket.close()
    socket.close()
    await expect(result).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('refuses clearly when the socket is gone', async () => {
    await expect(
      postToSession({ socket: join(dir, 'gone.sock'), token: 'f00d' }, 'hi'),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringMatching(/no longer/) })
  })
})
