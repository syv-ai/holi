import type { BrowserWindow, WebContents, WebRequest } from 'electron'

/** Correlates Chromium's native requester with the Request passed to protocol.handle.
 * Electron 43 omits requester identity from protocol Request, so URL-only matching
 * is safe only when exactly one native request for that URL is pending.
 */
export function createNativeRequestWindows(input: {
  webRequest: Pick<WebRequest, 'onBeforeRequest'>
  windowForContents(contents: WebContents): BrowserWindow | null
  contentsForId(id: number): WebContents | undefined
}): (request: Request) => BrowserWindow | null {
  const pending = new Map<string, { window: BrowserWindow | null }[]>()
  const resolved = new WeakMap<Request, BrowserWindow | null>()
  input.webRequest.onBeforeRequest({ urls: ['holi-app://*/*'] }, (details, callback) => {
    let window: BrowserWindow | null = null
    try {
      const contents =
        details.webContentsId === undefined ? undefined : input.contentsForId(details.webContentsId)
      window = contents === undefined ? null : input.windowForContents(contents)
    } catch {
      window = null
    }
    const requests = pending.get(details.url) ?? []
    const record = { window }
    requests.push(record)
    pending.set(details.url, requests)
    const timeout = setTimeout(() => {
      const index = requests.indexOf(record)
      if (index >= 0) requests.splice(index, 1)
      if (requests.length === 0 && pending.get(details.url) === requests)
        pending.delete(details.url)
    }, 5_000)
    timeout.unref()
    callback({})
  })
  return (request) => {
    if (resolved.has(request)) return resolved.get(request) ?? null
    const requests = pending.get(request.url)
    if (requests === undefined || requests.length !== 1) return null
    const window = requests[0]!.window
    pending.delete(request.url)
    resolved.set(request, window)
    return window
  }
}
