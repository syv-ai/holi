import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, session as electronSession } from 'electron'
import type { Session } from 'electron'
import type { MdxDiagnostic } from '@holi/shared'

const MAX_SOURCE_BYTES = 256 * 1024
const MAX_RESULT_BYTES = 32 * 1024
const MAX_DIAGNOSTICS = 32
const MAX_MESSAGE = 512
const QUEUE_TIMEOUT_MS = 10_000
const COMPILE_TIMEOUT_MS = 5_000
const MAX_PENDING = 4
const ORIGIN = 'https://mdx-compiler.invalid'
const HTML_URL = `${ORIGIN}/guest.html`
const SCRIPT_URL = `${ORIGIN}/guest.js`
const CSP = `default-src 'none'; script-src ${SCRIPT_URL}; connect-src 'none'; img-src 'none'; style-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none';`

export interface MdxCompiler {
  compile(source: string, signal?: AbortSignal): Promise<MdxDiagnostic[]>
  invalidate(): void
  close(): void
}

interface Request {
  source: string
  signal?: AbortSignal
  epoch: number
  resolve(value: MdxDiagnostic[]): void
  reject(error: Error): void
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
  abort?: () => void
  cancel?: (error: Error) => void
  cancellation: Promise<void>
  cancelRun(): void
}

/** Compile MDX in a fresh, offline, sandboxed renderer; never evaluate its output. */
export function createMdxCompiler(assetDirectory: string): MdxCompiler {
  let closed = false
  let epoch = 0
  let active = false
  let guestSession: Session | undefined
  let pumpScheduled = false
  const queue: Request[] = []
  const running = new Set<Request>()
  const guests = new Set<BrowserWindow>()
  let downloadListener: ((event: Electron.Event) => void) | undefined
  let webRequestListener:
    | ((
        details: Electron.OnBeforeRequestListenerDetails,
        callback: (response: Electron.CallbackResponse) => void,
      ) => void)
    | undefined
  let headersListener:
    | ((
        details: Electron.OnHeadersReceivedListenerDetails,
        callback: (response: Electron.HeadersReceivedResponse) => void,
      ) => void)
    | undefined

  function makeError(message: string): Error {
    return new Error(message.slice(0, MAX_MESSAGE))
  }

  function settle(request: Request, error?: Error, diagnostics?: MdxDiagnostic[]): void {
    if (request.settled) return
    request.settled = true
    if (request.timer) clearTimeout(request.timer)
    if (request.abort) request.signal?.removeEventListener('abort', request.abort)
    request.cancel = undefined
    running.delete(request)
    if (error) request.reject(error)
    else request.resolve(diagnostics ?? [])
  }

  function assertCurrent(request: Request): void {
    if (closed) throw makeError('MDX compiler is unavailable')
    if (request.signal?.aborted) throw makeError('MDX compilation cancelled')
    if (request.epoch !== epoch) throw makeError('MDX compilation invalidated')
    if (request.settled) throw makeError('MDX compilation cancelled')
  }

  function installSessionPolicy(session: Session): void {
    webRequestListener = (details, callback) => {
      const url = details.url
      const permitted =
        details.method === 'GET' &&
        (url === HTML_URL || url === SCRIPT_URL) &&
        !details.uploadData?.length
      callback({ cancel: !permitted })
    }
    headersListener = (details, callback) =>
      callback({
        responseHeaders: {
          'Content-Type': [
            details.url === SCRIPT_URL
              ? 'text/javascript; charset=utf-8'
              : 'text/html; charset=utf-8',
          ],
          'Content-Security-Policy': [CSP],
          'X-Content-Type-Options': ['nosniff'],
          'Cache-Control': ['no-store'],
        },
      })
    session.webRequest.onBeforeRequest(webRequestListener)
    session.webRequest.onHeadersReceived(headersListener)
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)
    session.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    downloadListener = (event) => event.preventDefault()
    session.on('will-download', downloadListener)
    session.protocol.handle('https', async (request) => {
      const url = new URL(request.url)
      if (
        request.method !== 'GET' ||
        url.protocol !== 'https:' ||
        url.hostname !== 'mdx-compiler.invalid' ||
        url.port !== '' ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== '' ||
        (url.pathname !== '/guest.html' && url.pathname !== '/guest.js')
      )
        return new Response('Not found', { status: 404 })
      try {
        const bytes = await readFile(
          join(assetDirectory, url.pathname === '/guest.html' ? 'guest.html' : 'guest.js'),
        )
        return new Response(bytes, {
          headers: {
            'Content-Type':
              url.pathname === '/guest.html'
                ? 'text/html; charset=utf-8'
                : 'text/javascript; charset=utf-8',
            'Content-Security-Policy': CSP,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
          },
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
  }

  async function getSession(request: Request): Promise<Session> {
    assertCurrent(request)
    if (!guestSession) {
      guestSession = electronSession.fromPartition(`mdx-compiler-${randomUUID()}`, { cache: false })
      installSessionPolicy(guestSession)
    }
    return guestSession
  }

  async function clearSession(session: Session, request: Request): Promise<void> {
    await session.clearStorageData()
    assertCurrent(request)
    await session.clearCache()
    assertCurrent(request)
  }

  function cleanDiagnostics(value: unknown): MdxDiagnostic[] {
    if (!Array.isArray(value)) throw makeError('MDX compiler returned an invalid result')
    return value.slice(0, MAX_DIAGNOSTICS).flatMap((item): MdxDiagnostic[] => {
      if (
        item === null ||
        typeof item !== 'object' ||
        typeof (item as MdxDiagnostic).message !== 'string' ||
        !Number.isFinite((item as MdxDiagnostic).line) ||
        !Number.isFinite((item as MdxDiagnostic).column)
      )
        return []
      const diagnostic = item as MdxDiagnostic
      return [
        {
          message: diagnostic.message.slice(0, MAX_MESSAGE),
          line: Math.max(1, Math.min(1_000_000, Math.floor(diagnostic.line))),
          column: Math.max(1, Math.min(1_000_000, Math.floor(diagnostic.column))),
        },
      ]
    })
  }

  async function compileOne(request: Request): Promise<void> {
    let guest: BrowserWindow | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let initialNavigation = true
    let finishing = false
    const session = await getSession(request)
    assertCurrent(request)
    await clearSession(session, request)
    assertCurrent(request)
    const [html, script] = await Promise.all([
      readFile(join(assetDirectory, 'guest.html')),
      readFile(join(assetDirectory, 'guest.js')),
    ])
    assertCurrent(request)
    if (html.byteLength > 16 * 1024 || script.byteLength > 2 * 1024 * 1024)
      throw makeError('MDX compiler assets exceed their size limits')

    guest = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        backgroundThrottling: false,
      },
    })
    guests.add(guest)
    guest.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.webContents.on('will-navigate', (event, url) => {
      if (initialNavigation && url === HTML_URL) initialNavigation = false
      else event.preventDefault()
    })
    guest.webContents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame || event.url !== HTML_URL || !initialNavigation) event.preventDefault()
    })

    const finish = async (error?: Error, result?: MdxDiagnostic[]) => {
      if (finishing) return
      finishing = true
      if (timer) clearTimeout(timer)
      if (pollTimer) clearTimeout(pollTimer)
      guests.delete(guest!)
      if (guest && !guest.isDestroyed()) guest.destroy()
      try {
        await clearSession(session, request)
        if (error) settle(request, error)
        else settle(request, undefined, result)
      } catch (cleanupError) {
        settle(
          request,
          error ??
            (cleanupError instanceof Error
              ? cleanupError
              : makeError('MDX compiler cleanup failed')),
        )
      } finally {
        request.cancelRun()
      }
    }
    request.cancel = (error) => {
      void finish(error)
      request.cancelRun()
    }
    timer = setTimeout(() => {
      void finish(makeError('MDX compilation timed out'))
    }, COMPILE_TIMEOUT_MS)
    guest.once('closed', () => {
      void finish(makeError('MDX compiler guest closed'))
    })
    guest.webContents.once('render-process-gone', () => {
      void finish(makeError('MDX compiler guest crashed'))
    })

    try {
      const loading = guest.loadURL(HTML_URL)
      await loading
      assertCurrent(request)
      initialNavigation = false
      const id = randomUUID()
      const payload = Buffer.from(JSON.stringify({ id, source: request.source }), 'utf8').toString(
        'base64',
      )
      await guest.webContents.executeJavaScript(`window.__holiMdxReceive('${payload}')`)
      assertCurrent(request)
      const deadline = Date.now() + COMPILE_TIMEOUT_MS
      while (!finishing) {
        assertCurrent(request)
        const result = (await guest.webContents.executeJavaScript(
          'window.__holiMdxTakeResult()',
        )) as unknown
        assertCurrent(request)
        if (result !== null && result !== undefined) {
          const serialized = JSON.stringify(result)
          if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES)
            throw makeError('MDX compiler result exceeds 32 KiB')
          const envelope = result as { id?: unknown; diagnostics?: unknown }
          if (envelope.id === id) {
            await finish(undefined, cleanDiagnostics(envelope.diagnostics))
            return
          }
        }
        if (Date.now() >= deadline) throw makeError('MDX compilation timed out')
        await new Promise<void>((resolve) => {
          pollTimer = setTimeout(resolve, 15)
        })
        pollTimer = undefined
      }
    } catch (error) {
      await finish(
        error instanceof Error ? makeError(error.message) : makeError('MDX compiler unavailable'),
      )
    }
  }

  function schedule(): void {
    if (pumpScheduled || active || closed) return
    pumpScheduled = true
    queueMicrotask(() => {
      pumpScheduled = false
      if (active || closed) return
      const request = queue.shift()
      if (!request) return
      if (request.settled) {
        schedule()
        return
      }
      active = true
      running.add(request)
      if (request.timer) clearTimeout(request.timer)
      request.cancel = (error) => {
        settle(request, error)
        request.cancelRun()
      }
      request.timer = setTimeout(() => {
        const error = makeError('MDX compilation timed out')
        request.cancel?.(error)
        settle(request, error)
      }, COMPILE_TIMEOUT_MS)
      void Promise.race([compileOne(request), request.cancellation])
        .catch((error: unknown) => {
          settle(
            request,
            error instanceof Error
              ? makeError(error.message)
              : makeError('MDX compiler unavailable'),
          )
        })
        .finally(() => {
          active = false
          schedule()
        })
    })
  }

  function compile(source: string, signal?: AbortSignal): Promise<MdxDiagnostic[]> {
    if (closed) return Promise.reject(makeError('MDX compiler is unavailable'))
    if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES)
      return Promise.reject(makeError('MDX source exceeds 256 KiB'))
    if (signal?.aborted) return Promise.reject(makeError('MDX compilation cancelled'))
    if (queue.length + (active ? 1 : 0) >= MAX_PENDING)
      return Promise.reject(makeError('MDX compiler queue is full'))
    return new Promise((resolve, reject) => {
      let cancelRun!: () => void
      const cancellation = new Promise<void>((resolveCancellation) => {
        cancelRun = resolveCancellation
      })
      const request: Request = {
        source,
        signal,
        epoch,
        resolve,
        reject,
        settled: false,
        cancellation,
        cancelRun,
      }
      request.abort = () => {
        const index = queue.indexOf(request)
        if (index >= 0) queue.splice(index, 1)
        const error = makeError('MDX compilation cancelled')
        request.cancel?.(error)
        settle(request, error)
        schedule()
      }
      signal?.addEventListener('abort', request.abort, { once: true })
      request.timer = setTimeout(() => {
        const index = queue.indexOf(request)
        if (index >= 0) queue.splice(index, 1)
        const error = makeError('MDX compilation timed out')
        request.cancel?.(error)
        settle(request, error)
        schedule()
      }, QUEUE_TIMEOUT_MS)
      queue.push(request)
      schedule()
    })
  }

  function removeSessionPolicy(): void {
    if (!guestSession) return
    if (webRequestListener) guestSession.webRequest.onBeforeRequest(null as never)
    if (headersListener) guestSession.webRequest.onHeadersReceived(null as never)
    if (downloadListener) guestSession.removeListener('will-download', downloadListener)
    guestSession.setPermissionRequestHandler(null as never)
    guestSession.setPermissionCheckHandler(null as never)
    guestSession.setDisplayMediaRequestHandler(null as never)
    guestSession.protocol.unhandle('https')
    webRequestListener = undefined
    headersListener = undefined
    downloadListener = undefined
  }

  return {
    compile,
    invalidate() {
      if (closed) return
      epoch++
      const error = makeError('MDX compilation invalidated')
      for (const request of [...queue]) settle(request, error)
      queue.length = 0
      for (const request of running) {
        request.cancel?.(error)
        settle(request, error)
      }
      schedule()
    },
    close() {
      if (closed) return
      closed = true
      for (const request of [...queue]) settle(request, makeError('MDX compiler is unavailable'))
      queue.length = 0
      for (const request of running) {
        const error = makeError('MDX compiler is unavailable')
        if (request.timer) clearTimeout(request.timer)
        request.cancel?.(error)
        settle(request, error)
      }
      for (const guest of guests) if (!guest.isDestroyed()) guest.destroy()
      guests.clear()
      removeSessionPolicy()
    },
  }
}
