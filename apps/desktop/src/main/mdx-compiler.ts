import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, session as electronSession } from 'electron'
import type { MdxDiagnostic } from '@holi/shared'

const MAX_SOURCE_BYTES = 256 * 1024
const MAX_DIAGNOSTICS = 32
const MAX_MESSAGE = 512
const TIMEOUT_MS = 5_000

export interface MdxCompiler {
  compile(source: string, signal?: AbortSignal): Promise<MdxDiagnostic[]>
  invalidate(): void
  close(): void
}

/**
 * Compiles MDX in a fresh, offline, sandboxed renderer. The generated program
 * is discarded: this adapter has no path that evaluates it.
 */
export function createMdxCompiler(assetDirectory: string): MdxCompiler {
  let closed = false
  let pending = 0
  let epoch = 0
  let queue: Promise<unknown> = Promise.resolve()
  const guests = new Set<BrowserWindow>()

  function compile(source: string, signal?: AbortSignal): Promise<MdxDiagnostic[]> {
    if (pending >= 4) return Promise.reject(new Error('MDX compiler queue is full'))
    pending++
    const requestedEpoch = epoch
    const run = () =>
      requestedEpoch === epoch
        ? compileOne(source, signal)
        : Promise.reject(new Error('MDX compilation invalidated'))
    const result = queue.then(run, run)
    queue = result.finally(() => pending--).catch(() => undefined)
    return result
  }

  async function compileOne(source: string, signal?: AbortSignal): Promise<MdxDiagnostic[]> {
    if (closed) throw new Error('MDX compiler is unavailable')
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES)
      throw new Error('MDX source exceeds 256 KiB')
    if (signal?.aborted) throw new Error('MDX compilation cancelled')

    const requestedEpoch = epoch
    const id = randomUUID()
    const html = join(assetDirectory, 'guest.html')
    const script = join(assetDirectory, 'guest.js')
    await Promise.all([readFile(html), readFile(script)])
    if (closed || signal?.aborted || requestedEpoch !== epoch)
      throw new Error(signal?.aborted ? 'MDX compilation cancelled' : 'MDX compilation invalidated')

    const partition = `mdx-compiler-${randomUUID()}`
    const guestSession = electronSession.fromPartition(partition, { cache: false })
    const allow = new Set([html, script].map((path) => pathToFileURL(path).href))
    guestSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !allow.has(details.url) })
    })
    guestSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'none'; script-src 'self'; connect-src 'none'; img-src 'none'; style-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
          ],
          'X-Content-Type-Options': ['nosniff'],
        },
      })
    })
    guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    guestSession.setPermissionCheckHandler(() => false)
    guestSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    guestSession.on('will-download', (event) => event.preventDefault())

    const guest = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        session: guestSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    })
    guests.add(guest)
    guest.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.webContents.on('will-navigate', (event, url) => {
      if (!allow.has(url)) event.preventDefault()
    })
    guest.webContents.on('will-frame-navigate', (event) => event.preventDefault())

    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const dispose = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort!)
      guests.delete(guest)
      if (!guest.isDestroyed()) guest.destroy()
    }
    try {
      return await new Promise<MdxDiagnostic[]>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error, result?: MdxDiagnostic[]) => {
          if (settled) return
          settled = true
          dispose()
          if (error) reject(error)
          else resolve(result ?? [])
        }
        abort = () => finish(new Error('MDX compilation cancelled'))
        signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => finish(new Error('MDX compilation timed out')), TIMEOUT_MS)
        guest.once('closed', () => finish(new Error('MDX compiler guest closed')))
        guest.webContents.once('render-process-gone', () =>
          finish(new Error('MDX compiler guest crashed')),
        )
        guest
          .loadFile(html)
          .then(async () => {
            if (signal?.aborted) return finish(new Error('MDX compilation cancelled'))
            const encoded = Buffer.from(JSON.stringify({ id, source }), 'utf8').toString('base64')
            // Fixed invocation; source crosses only as base64-encoded JSON data.
            await guest.webContents.executeJavaScript(
              `window.postMessage(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'), (c) => c.charCodeAt(0)))), '*')`,
            )
            while (!settled) {
              if (signal?.aborted) return finish(new Error('MDX compilation cancelled'))
              const answer = (await guest.webContents.executeJavaScript(
                'window.__holiMdxResult || null',
              )) as {
                id?: unknown
                diagnostics?: unknown
              } | null
              if (answer?.id === id && Array.isArray(answer.diagnostics)) {
                const diagnostics = answer.diagnostics
                  .slice(0, MAX_DIAGNOSTICS)
                  .filter(
                    (item): item is MdxDiagnostic =>
                      item !== null &&
                      typeof item === 'object' &&
                      typeof (item as MdxDiagnostic).message === 'string' &&
                      Number.isFinite((item as MdxDiagnostic).line) &&
                      Number.isFinite((item as MdxDiagnostic).column) &&
                      Math.abs((item as MdxDiagnostic).line) <= 1_000_000 &&
                      Math.abs((item as MdxDiagnostic).column) <= 1_000_000,
                  )
                  .map((item) => ({
                    message: item.message.slice(0, MAX_MESSAGE),
                    line: Math.max(1, Math.floor(item.line)),
                    column: Math.max(1, Math.floor(item.column)),
                  }))
                finish(undefined, diagnostics)
                return
              }
              await new Promise((wait) => setTimeout(wait, 15))
            }
          })
          .catch((error: unknown) =>
            finish(error instanceof Error ? error : new Error('MDX compiler unavailable')),
          )
      })
    } finally {
      dispose()
    }
  }

  return {
    compile,
    invalidate() {
      epoch++
      for (const guest of guests) if (!guest.isDestroyed()) guest.destroy()
      guests.clear()
    },
    close() {
      closed = true
      for (const guest of guests) if (!guest.isDestroyed()) guest.destroy()
      guests.clear()
    },
  }
}
