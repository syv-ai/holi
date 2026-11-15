import type { BrowserWindow, WebContents, WebFrameMain, WebRequest } from 'electron'

const frameId = (frame: WebFrameMain): string => String(frame.frameTreeNodeId)

/** Correlates Chromium's native frame requester with protocol.handle's Request.
 * Electron 43's protocol Request omits identity; ambiguous URL matches fail closed.
 */
export type NativeRequestWindows = ((request: Request) => BrowserWindow | null) & {
  frameForRequest(request: Request): string | null
}

export function createNativeRequestWindows(input: {
  webRequest: Pick<WebRequest, 'onBeforeRequest'>
  windowForContents(contents: WebContents): BrowserWindow | null
  contentsForId(id: number): WebContents | undefined
}): NativeRequestWindows {
  const pending = new Map<string, { window: BrowserWindow | null; frame: string | null }[]>()
  const resolved = new WeakMap<Request, { window: BrowserWindow | null; frame: string | null }>()
  input.webRequest.onBeforeRequest({ urls: ['holi-app://*/*'] }, (details, callback) => {
    let window: BrowserWindow | null = null
    let frame: string | null = null
    try {
      const contents =
        details.webContentsId === undefined ? undefined : input.contentsForId(details.webContentsId)
      window = contents === undefined ? null : input.windowForContents(contents)
      frame = details.frame == null ? null : frameId(details.frame)
    } catch {
      window = null
      frame = null
    }
    const requests = pending.get(details.url) ?? []
    const record = { window, frame }
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
  const resolve = (
    request: Request,
  ): { window: BrowserWindow | null; frame: string | null } | null => {
    if (resolved.has(request)) return resolved.get(request) ?? null
    const requests = pending.get(request.url)
    if (requests === undefined || requests.length !== 1) return null
    const record = requests[0]!
    pending.delete(request.url)
    resolved.set(request, record)
    return record
  }
  const windowForRequest = ((request: Request) =>
    resolve(request)?.window ?? null) as NativeRequestWindows
  windowForRequest.frameForRequest = (request) => resolve(request)?.frame ?? null
  return windowForRequest
}
