import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, session as electronSession, webContents } from 'electron'
import type { Session } from 'electron'
import {
  MAX_MDX_ARTIFACT_BYTES,
  MAX_MDX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_MDX_INSPECTION_DEPENDENCIES,
  MAX_MDX_INSPECTION_DIAGNOSTICS,
  MAX_MDX_SPECIFIER_LENGTH,
  type MdxDiagnostic,
} from '@holi/shared'

const MAX_SOURCE_BYTES = 256 * 1024
// JSON can use six bytes per UTF-16 code unit (e.g. a lone surrogate).
// Each 128-byte allowance covers keys, positions and punctuation, or the UUID envelope.
// The guest may send one extra dependency to signal overflow without returning a partial graph.
const MAX_ARTIFACT_BYTES = MAX_MDX_ARTIFACT_BYTES
const MAX_RESULT_BYTES =
  6 * MAX_ARTIFACT_BYTES +
  128 +
  (MAX_MDX_INSPECTION_DEPENDENCIES + 1) * (128 + 6 * MAX_MDX_SPECIFIER_LENGTH) +
  MAX_MDX_INSPECTION_DIAGNOSTICS * (128 + 6 * MAX_MDX_DIAGNOSTIC_MESSAGE_LENGTH)
const QUEUE_TIMEOUT_MS = 10_000
const COMPILE_TIMEOUT_MS = 5_000
const MAX_PENDING = 4
const ORIGIN = 'https://mdx-compiler.invalid'
const HTML_URL = `${ORIGIN}/guest.html`
const SCRIPT_URL = `${ORIGIN}/guest.js`
const CSP = `default-src 'none'; script-src ${SCRIPT_URL}; connect-src 'none'; img-src 'none'; style-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none';`

export type MdxResourceOwner = object

interface MdxDependency {
  specifier: string
  line: number
  column: number
}

export interface MdxInspectResult {
  diagnostics: MdxDiagnostic[]
  dependencies: MdxDependency[]
  /** Generated module text, returned as inert data and never evaluated by main. */
  artifact?: string
}

export interface MdxResources {
  createOwner(isCurrent: () => Promise<boolean>): MdxResourceOwner
  retireOwner(owner: MdxResourceOwner): void
  compile(owner: MdxResourceOwner, source: string, signal?: AbortSignal): Promise<MdxDiagnostic[]>
  inspect(
    owner: MdxResourceOwner,
    source: string,
    signal?: AbortSignal,
    format?: 'mdx' | 'jsx' | 'js',
    options?: { emitArtifact?: boolean },
  ): Promise<MdxInspectResult>
  invalidate(): void
  close(): void
}

interface Request {
  owner: MdxResourceOwner
  source: string
  format: 'mdx' | 'jsx' | 'js'
  emitArtifact: boolean
  signal?: AbortSignal
  epoch: number
  resolve(value: MdxInspectResult): void
  reject(error: Error): void
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
  abort?: () => void
  cancel?: (error: Error) => void
  cleanup?: () => void
  cancellation: Promise<void>
  cancelRun(): void
}

class MdxCompilerError extends Error {}

/** Compile MDX in a fresh, offline, sandboxed renderer; never evaluate its output. */
export function createMdxResources(assetDirectory: string): MdxResources {
  let closed = false
  let epoch = 0
  let active = false
  const owners = new Map<MdxResourceOwner, () => Promise<boolean>>()
  const sessionCleanup = new Map<Session, () => void>()
  const sessionGuestIds = new Map<Session, (id: number) => void>()
  let pumpScheduled = false
  const queue: Request[] = []
  const running = new Set<Request>()
  const guests = new Set<BrowserWindow>()

  function makeError(message: string): Error {
    return new MdxCompilerError(message.slice(0, MAX_MDX_DIAGNOSTIC_MESSAGE_LENGTH))
  }

  function settle(request: Request, error?: Error, result?: MdxInspectResult): void {
    if (request.settled) return
    request.settled = true
    if (request.timer) clearTimeout(request.timer)
    if (request.abort) request.signal?.removeEventListener('abort', request.abort)
    request.cancel = undefined
    running.delete(request)
    if (error) request.reject(error)
    else request.resolve(result ?? { diagnostics: [], dependencies: [] })
  }

  async function assertCurrent(request: Request): Promise<void> {
    if (closed) throw makeError('MDX compiler is unavailable')
    if (request.signal?.aborted) throw makeError('MDX compilation cancelled')
    if (request.epoch !== epoch) throw makeError('MDX compilation invalidated')
    if (request.settled) throw makeError('MDX compilation cancelled')
    const isCurrent = owners.get(request.owner)
    if (isCurrent === undefined) throw makeError('MDX resource owner unavailable')
    const ownerIsCurrent = await isCurrent()
    if (closed || request.signal?.aborted || request.epoch !== epoch || request.settled)
      throw makeError('MDX compilation cancelled')
    if (!ownerIsCurrent || owners.get(request.owner) !== isCurrent)
      throw makeError('MDX resource owner unavailable')
  }

  function installSessionPolicy(session: Session, request: Request): void {
    let guestId: number | null = null
    let documentConsumed = false
    let scriptConsumed = false
    const live = async () => {
      try {
        await assertCurrent(request)
        return true
      } catch {
        return false
      }
    }
    const webRequestListener = async (
      details: Electron.OnBeforeRequestListenerDetails,
      callback: (response: Electron.CallbackResponse) => void,
    ) => {
      const url = details.url
      const contents =
        typeof details.webContentsId === 'number'
          ? webContents.fromId(details.webContentsId)
          : undefined
      const frame = details.frame
      let mainFrame = false
      if (contents !== undefined && !contents.isDestroyed() && frame != null) {
        try {
          mainFrame = frame.frameTreeNodeId === contents.mainFrame.frameTreeNodeId
        } catch {
          mainFrame = false
        }
      }
      // A URL allowlist alone is not ownership: only the active compiler guest
      // may fetch the document, and its one script must be a script subresource.
      let permitted = false
      try {
        permitted =
          (await live()) &&
          details.webContentsId === guestId &&
          details.method === 'GET' &&
          !details.uploadData?.length &&
          ((url === HTML_URL &&
            details.resourceType === 'mainFrame' &&
            mainFrame &&
            !documentConsumed) ||
            (url === SCRIPT_URL &&
              details.resourceType === 'script' &&
              mainFrame &&
              !scriptConsumed))
      } catch {
        permitted = false
      }
      if (permitted) {
        if (url === HTML_URL) documentConsumed = true
        else scriptConsumed = true
      }
      callback({ cancel: !permitted })
    }
    const headersListener = (
      details: Electron.OnHeadersReceivedListenerDetails,
      callback: (response: Electron.HeadersReceivedResponse) => void,
    ) =>
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
    const downloadListener = (event: Electron.Event) => event.preventDefault()
    session.on('will-download', downloadListener)
    session.protocol.handle('https', async (protocolRequest) => {
      const url = new URL(protocolRequest.url)
      if (
        !(await live()) ||
        protocolRequest.method !== 'GET' ||
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
        if (!(await live())) return new Response('Not found', { status: 404 })
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
    sessionGuestIds.set(session, (id) => {
      guestId = id
    })
    sessionCleanup.set(session, () => {
      session.webRequest.onBeforeRequest(null as never)
      session.webRequest.onHeadersReceived(null as never)
      session.removeListener('will-download', downloadListener)
      session.setPermissionRequestHandler(null as never)
      session.setPermissionCheckHandler(null as never)
      session.setDisplayMediaRequestHandler(null as never)
      session.protocol.unhandle('https')
      request.cleanup = undefined
      sessionCleanup.delete(session)
      sessionGuestIds.delete(session)
    })
    request.cleanup = sessionCleanup.get(session)
  }

  async function getSession(request: Request): Promise<Session> {
    await assertCurrent(request)
    const session = electronSession.fromPartition(`mdx-compiler-${randomUUID()}`, { cache: false })
    installSessionPolicy(session, request)
    return session
  }

  async function clearSession(session: Session, request?: Request): Promise<void> {
    await session.clearStorageData()
    if (request) await assertCurrent(request)
    await session.clearCache()
    if (request) await assertCurrent(request)
  }

  function cleanDiagnostics(value: unknown, strict = false): MdxDiagnostic[] {
    if (!Array.isArray(value)) throw makeError('MDX compiler returned an invalid result')
    if (
      strict &&
      (value.length > MAX_MDX_INSPECTION_DIAGNOSTICS ||
        value.some(
          (item) =>
            item === null ||
            typeof item !== 'object' ||
            typeof item.message !== 'string' ||
            item.message.length > MAX_MDX_DIAGNOSTIC_MESSAGE_LENGTH ||
            !Number.isSafeInteger(item.line) ||
            item.line < 1 ||
            item.line > 1_000_000 ||
            !Number.isSafeInteger(item.column) ||
            item.column < 1 ||
            item.column > 1_000_000,
        ))
    )
      throw makeError('MDX compiler returned invalid diagnostics')
    return value.slice(0, MAX_MDX_INSPECTION_DIAGNOSTICS).flatMap((item): MdxDiagnostic[] => {
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
          message: diagnostic.message.slice(0, MAX_MDX_DIAGNOSTIC_MESSAGE_LENGTH),
          line: Math.max(1, Math.min(1_000_000, Math.floor(diagnostic.line))),
          column: Math.max(1, Math.min(1_000_000, Math.floor(diagnostic.column))),
        },
      ]
    })
  }

  async function compileOne(request: Request): Promise<void> {
    await assertCurrent(request)
    let guest: BrowserWindow | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let initialNavigation = true
    let finishing = false
    const [html, script] = await Promise.all([
      readFile(join(assetDirectory, 'guest.html')),
      readFile(join(assetDirectory, 'guest.js')),
    ])
    await assertCurrent(request)
    if (html.byteLength > 16 * 1024 || script.byteLength > 2 * 1024 * 1024)
      throw makeError('MDX compiler assets exceed their size limits')
    const session = await getSession(request)
    try {
      await clearSession(session, request)
      await assertCurrent(request)
    } catch (error) {
      sessionCleanup.get(session)?.()
      throw error
    }

    try {
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
    } catch (error) {
      sessionCleanup.get(session)?.()
      throw error
    }
    guests.add(guest)
    sessionGuestIds.get(session)?.(guest.webContents.id)
    guest.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.webContents.on('will-redirect', (event) => event.preventDefault())
    guest.webContents.on('will-attach-webview', (event) => event.preventDefault())
    guest.webContents.on('will-navigate', (event, url) => {
      if (initialNavigation && url === HTML_URL) initialNavigation = false
      else event.preventDefault()
    })
    guest.webContents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame || event.url !== HTML_URL || !initialNavigation) event.preventDefault()
    })

    const finish = async (error?: Error, result?: MdxInspectResult) => {
      if (finishing) return
      finishing = true
      if (timer) clearTimeout(timer)
      if (pollTimer) clearTimeout(pollTimer)
      guests.delete(guest!)
      if (guest && !guest.isDestroyed()) guest.destroy()
      try {
        await clearSession(session)
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
        sessionCleanup.get(session)?.()
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
      await assertCurrent(request)
      initialNavigation = false
      const id = randomUUID()
      const payload = Buffer.from(
        JSON.stringify({
          id,
          source: request.source,
          format: request.format,
          emitArtifact: request.emitArtifact,
        }),
        'utf8',
      ).toString('base64')
      await guest.webContents.executeJavaScript(`window.__holiMdxReceive('${payload}')`)
      await assertCurrent(request)
      const deadline = Date.now() + COMPILE_TIMEOUT_MS
      while (!finishing) {
        await assertCurrent(request)
        const result = (await guest.webContents.executeJavaScript(
          'window.__holiMdxTakeResult()',
        )) as unknown
        await assertCurrent(request)
        if (result !== null && result !== undefined) {
          const serialized = JSON.stringify(result)
          if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES)
            throw makeError('MDX compiler result exceeds its size limit')
          const envelope = result as {
            id?: unknown
            diagnostics?: unknown
            dependencies?: unknown
            artifact?: unknown
          }
          if (envelope.id === id) {
            if (
              !Array.isArray(envelope.dependencies) ||
              envelope.dependencies.length > MAX_MDX_INSPECTION_DEPENDENCIES
            )
              throw makeError('MDX compiler dependency limit or invalid result')
            const diagnostics = cleanDiagnostics(envelope.diagnostics, request.emitArtifact)
            if (
              (request.emitArtifact &&
                diagnostics.length === 0 &&
                typeof envelope.artifact !== 'string') ||
              (request.emitArtifact && diagnostics.length > 0 && envelope.artifact !== undefined) ||
              (!request.emitArtifact && envelope.artifact !== undefined)
            )
              throw makeError('Invalid MDX compiler artifact response')
            const dependencies = envelope.dependencies.map((item): MdxDependency => {
              if (!item || typeof item !== 'object') throw makeError('Invalid MDX dependency')
              const value = item as MdxDependency
              if (
                typeof value.specifier !== 'string' ||
                value.specifier.length > MAX_MDX_SPECIFIER_LENGTH ||
                (!(
                  request.emitArtifact && ['react', 'react/jsx-runtime'].includes(value.specifier)
                ) &&
                  !/^(?:\.\.?\/|\/(?!\/)|https:\/\/)/i.test(value.specifier)) ||
                !Number.isSafeInteger(value.line) ||
                value.line < 1 ||
                !Number.isSafeInteger(value.column) ||
                value.column < 1
              )
                throw makeError('Invalid MDX dependency')
              return { specifier: value.specifier, line: value.line, column: value.column }
            })
            if (
              envelope.artifact !== undefined &&
              (typeof envelope.artifact !== 'string' ||
                Buffer.byteLength(envelope.artifact, 'utf8') > MAX_ARTIFACT_BYTES)
            )
              throw makeError('Invalid or oversized MDX compiler artifact')
            await finish(undefined, {
              diagnostics,
              dependencies,
              ...(typeof envelope.artifact === 'string' ? { artifact: envelope.artifact } : {}),
            })
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
        error instanceof MdxCompilerError || (!request.emitArtifact && error instanceof Error)
          ? makeError(error.message)
          : makeError('MDX compiler unavailable'),
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
        request.cleanup?.()
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
            error instanceof MdxCompilerError || (!request.emitArtifact && error instanceof Error)
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

  function createOwner(isCurrent: () => Promise<boolean>): MdxResourceOwner {
    if (closed) throw makeError('MDX compiler is unavailable')
    if (typeof isCurrent !== 'function') throw makeError('MDX resource owner unavailable')
    const owner = Object.freeze(Object.create(null)) as MdxResourceOwner
    owners.set(owner, isCurrent)
    return owner
  }

  function retireOwner(owner: MdxResourceOwner): void {
    owners.delete(owner)
    for (const request of [...queue]) {
      if (request.owner !== owner) continue
      queue.splice(queue.indexOf(request), 1)
      settle(request, makeError('MDX resource owner unavailable'))
    }
    for (const request of running)
      if (request.owner === owner) request.cancel?.(makeError('MDX resource owner unavailable'))
    schedule()
  }

  function inspect(
    owner: MdxResourceOwner,
    source: string,
    signal?: AbortSignal,
    format: 'mdx' | 'jsx' | 'js' = 'mdx',
    options: { emitArtifact?: boolean } = {},
  ): Promise<MdxInspectResult> {
    if (closed) return Promise.reject(makeError('MDX compiler is unavailable'))
    if (!owners.has(owner)) return Promise.reject(makeError('MDX resource owner unavailable'))
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
        owner,
        source,
        format,
        emitArtifact: options.emitArtifact === true,
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

  function compile(
    owner: MdxResourceOwner,
    source: string,
    signal?: AbortSignal,
  ): Promise<MdxDiagnostic[]> {
    return inspect(owner, source, signal).then((result) => result.diagnostics)
  }

  return {
    createOwner,
    retireOwner,
    compile,
    inspect,
    invalidate() {
      if (closed) return
      epoch++
      owners.clear()
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
      owners.clear()
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
    },
  }
}
