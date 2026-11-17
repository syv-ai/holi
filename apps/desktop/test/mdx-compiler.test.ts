import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  sessions: [] as FakeSession[],
  guests: [] as FakeGuest[],
  reads: vi.fn(),
  BrowserWindow: vi.fn(),
  fromPartition: vi.fn(),
  hangLoadNext: false,
  failLoadNext: false,
}))

class FakeSession extends EventEmitter {
  webRequest = { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() }
  protocol = { handle: vi.fn(), unhandle: vi.fn() }
  clearStorageData = vi.fn(async () => undefined)
  clearCache = vi.fn(async () => undefined)
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  setDisplayMediaRequestHandler = vi.fn()
  constructor() {
    super()
    state.sessions.push(this)
  }
}

class FakeGuest extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(),
    executeJavaScript: vi.fn(async (script: string) => {
      if (script.startsWith('window.__holiMdxReceive(')) {
        const encoded = script.slice("window.__holiMdxReceive('".length, -2)
        const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
          id: string
          source: string
        }
        this.result = { id: payload.id, diagnostics: [] }
        this.receivedSource = true
        this.source = payload.source
      }
      if (script === 'window.__holiMdxTakeResult()') {
        const result = this.result
        this.result = null
        return result
      }
      return undefined
    }),
  })
  result: unknown = null
  receivedSource = false
  source = ''
  destroyed = false
  options: Record<string, unknown>
  loadURL = vi.fn(() => {
    if (state.failLoadNext) {
      state.failLoadNext = false
      return Promise.reject(new Error('guest initialization denied'))
    }
    if (state.hangLoadNext) {
      state.hangLoadNext = false
      return new Promise<void>(() => undefined)
    }
    return Promise.resolve()
  })
  destroy = vi.fn(() => {
    this.destroyed = true
    this.emit('closed')
  })
  isDestroyed = () => this.destroyed
  constructor(options: Record<string, unknown> = {}) {
    super()
    this.options = options
    state.guests.push(this)
  }
}

vi.mock('electron', () => ({
  BrowserWindow: state.BrowserWindow,
  session: { fromPartition: state.fromPartition },
}))
vi.mock('node:fs/promises', () => ({
  readFile: (path: string) => state.reads(path),
}))

import { session } from 'electron'
import { createMdxCompiler } from '../src/main/mdx-compiler'

beforeEach(() => {
  vi.clearAllMocks()
  state.sessions.length = 0
  state.guests.length = 0
  state.hangLoadNext = false
  state.failLoadNext = false
  state.BrowserWindow.mockImplementation(() => new FakeGuest())
  state.fromPartition.mockImplementation(() => new FakeSession())
  state.reads.mockImplementation(async (path: string) => {
    if (path.endsWith('guest.html')) return Buffer.from('<html></html>')
    if (path.endsWith('guest.js')) return Buffer.from('fixed guest')
    throw new Error(`unexpected asset ${path}`)
  })
})

describe('isolated MDX compiler policy', () => {
  it('rejects oversized or already-cancelled work before creating a guest session', async () => {
    const compiler = createMdxCompiler('/assets')
    await expect(compiler.compile('x'.repeat(256 * 1024 + 1))).rejects.toThrow(/256 KiB/)
    const controller = new AbortController()
    controller.abort()
    await expect(compiler.compile('# no guest', controller.signal)).rejects.toThrow(/cancelled/)
    expect(session.fromPartition).not.toHaveBeenCalled()
    expect(state.guests).toHaveLength(0)
    compiler.close()
  })

  it('does not deliver source when the fixed guest fails to initialize', async () => {
    const compiler = createMdxCompiler('/assets')
    state.failLoadNext = true
    await expect(compiler.compile('# must not reach guest')).rejects.toThrow(
      /initialization denied/,
    )
    expect(state.guests[0].receivedSource).toBe(false)
    expect(state.guests[0].destroyed).toBe(true)
    compiler.close()
  })

  it('loads the fixed guest before delivering Unicode source through JSON data', async () => {
    const compiler = createMdxCompiler('/assets')
    await expect(compiler.compile('# héllo 🌱')).resolves.toEqual([])
    const guest = state.guests[0]
    expect(guest.loadURL).toHaveBeenCalledWith('https://mdx-compiler.invalid/guest.html')
    expect(guest.receivedSource).toBe(true)
    expect(guest.source).toBe('# héllo 🌱')
    const preferences = guest.options.webPreferences as Record<string, unknown>
    expect(preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
    })
    expect(guest.webContents.executeJavaScript.mock.calls[0][0]).not.toContain('héllo')
    expect(state.sessions[0].clearStorageData).toHaveBeenCalledTimes(2)
    expect(state.sessions[0].clearCache).toHaveBeenCalledTimes(2)
    compiler.close()
  })

  it('reuses one private session while creating and cleaning a fresh guest per request', async () => {
    const compiler = createMdxCompiler('/assets')
    await compiler.compile('# one')
    await compiler.compile('# two')
    expect(session.fromPartition).toHaveBeenCalledTimes(1)
    expect(session.fromPartition).toHaveBeenCalledWith(expect.stringMatching(/^mdx-compiler-/), {
      cache: false,
    })
    expect(state.guests).toHaveLength(2)
    expect(state.guests.every((guest) => guest.destroyed)).toBe(true)
    const privateSession = state.sessions[0]
    expect(privateSession.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)
    const beforeRequest = privateSession.webRequest.onBeforeRequest.mock.calls[0][0] as (
      details: { url: string; method: string; uploadData?: unknown[] },
      callback: (result: { cancel: boolean }) => void,
    ) => void
    for (const [url, method, cancelled] of [
      ['https://mdx-compiler.invalid/guest.html', 'GET', false],
      ['https://mdx-compiler.invalid/guest.html?x=1', 'GET', true],
      ['https://example.com/', 'GET', true],
      ['https://mdx-compiler.invalid/guest.js', 'POST', true],
    ] as const) {
      const callback = vi.fn()
      beforeRequest({ url, method }, callback)
      expect(callback).toHaveBeenCalledWith({ cancel: cancelled })
    }
    expect(privateSession.protocol.handle).toHaveBeenCalledWith('https', expect.any(Function))
    const handler = privateSession.protocol.handle.mock.calls[0][1] as (
      request: Request,
    ) => Promise<Response>
    const asset = await handler(new Request('https://mdx-compiler.invalid/guest.js'))
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('fixed guest')
    for (const url of [
      'https://mdx-compiler.invalid/other.js',
      'https://mdx-compiler.invalid/guest.js?x=1',
      'https://example.com/guest.js',
      'https://mdx-compiler.invalid/guest.html#fragment',
    ])
      expect((await handler(new Request(url))).status).toBe(404)
    compiler.close()
    expect(privateSession.protocol.unhandle).toHaveBeenCalledWith('https')
  })

  it('cancels queued work immediately and invalidation permits a subsequent compile', async () => {
    const compiler = createMdxCompiler('/assets')
    let releaseRead: (() => void) | undefined
    state.reads.mockImplementation(async (path: string) => {
      if (path.endsWith('guest.html')) {
        await new Promise<void>((resolve) => {
          releaseRead = resolve
        })
        return Buffer.from('<html></html>')
      }
      return Buffer.from('fixed guest')
    })
    const first = compiler.compile('# active')
    await vi.waitFor(() => expect(releaseRead).toBeDefined())
    const controller = new AbortController()
    const queued = compiler.compile('# queued', controller.signal)
    controller.abort()
    await expect(queued).rejects.toThrow(/cancelled/)
    compiler.invalidate()
    await expect(first).rejects.toThrow(/invalidated/)
    releaseRead?.()
    state.reads.mockImplementation(async (path: string) =>
      Buffer.from(path.endsWith('guest.html') ? '<html></html>' : 'fixed guest'),
    )
    await expect(compiler.compile('# latest')).resolves.toEqual([])
    compiler.close()
  })

  it('recovers from renderer crashes and a hung guest load', async () => {
    const compiler = createMdxCompiler('/assets')
    const crashed = compiler.compile('# crash')
    await vi.waitFor(() => expect(state.guests).toHaveLength(1))
    state.guests[0].webContents.emit('render-process-gone')
    await expect(crashed).rejects.toThrow(/crashed/)

    state.hangLoadNext = true
    const controller = new AbortController()
    const hung = compiler.compile('# hang', controller.signal)
    await vi.waitFor(() => expect(state.guests).toHaveLength(2))
    controller.abort()
    await expect(hung).rejects.toThrow(/cancelled/)
    await expect(compiler.compile('# recovered')).resolves.toEqual([])

    state.hangLoadNext = true
    const timedOut = compiler.compile('# timeout')
    await vi.waitFor(() => expect(state.guests).toHaveLength(4))
    await expect(timedOut).rejects.toThrow(/timed out/)
    await expect(compiler.compile('# recovered after timeout')).resolves.toEqual([])
    compiler.close()
  })

  it('enforces the four-request bound and permanently rejects work after close', async () => {
    const compiler = createMdxCompiler('/assets')
    const gate = vi.fn()
    state.reads.mockImplementation(async (path: string) => {
      await new Promise<void>((resolve) => gate.mockImplementation(resolve))
      return Buffer.from(path.endsWith('guest.html') ? '<html></html>' : 'fixed guest')
    })
    const requests = [
      compiler.compile('1'),
      compiler.compile('2'),
      compiler.compile('3'),
      compiler.compile('4'),
    ]
    await expect(compiler.compile('5')).rejects.toThrow(/queue is full/)
    compiler.close()
    await expect(Promise.all(requests)).rejects.toThrow()
    expect(gate).not.toHaveBeenCalled()
  })
})
