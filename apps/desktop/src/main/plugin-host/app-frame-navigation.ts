import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import type { AppFrameLeases } from '../plugin-api'

const frameKey = (frame: WebFrameMain): string => String(frame.frameTreeNodeId)

/** Revoke app-document authority at Electron's native navigation start, before commit/scripts. */
export function trackAppFrameDocuments(input: {
  contents: WebContents
  window: BrowserWindow
  leases: AppFrameLeases
  tokenFromUrl(url: string): string | null
}): () => void {
  const frameLeases = new Map<string, string>()
  const trackedTokens = new Set<string>()
  const removeToken = (token: string): void => {
    trackedTokens.delete(token)
    for (const [key, value] of frameLeases) {
      if (value === token) frameLeases.delete(key)
    }
  }
  const stopRevocations = input.leases.onRevoke(removeToken)
  const revokeFrame = (key: string): void => {
    const token = frameLeases.get(key)
    if (token === undefined) return
    const lease = input.leases.resolveToken(token)
    if (lease !== null) input.leases.revoke(lease)
    else removeToken(token)
  }
  const onNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ) => {
    if (details.isSameDocument || details.frame === null) return
    const key = frameKey(details.frame)
    // Revoke synchronously at navigation start. Never bind a new lease to this
    // frame after its original document has been replaced.
    if (frameLeases.has(key)) {
      revokeFrame(key)
      return
    }
    const token = input.tokenFromUrl(details.url)
    if (token === null || trackedTokens.has(token)) return
    const lease = input.leases.resolve(token, input.window)
    if (lease === null || !lease.bindDocument(key)) return
    frameLeases.set(key, token)
    trackedTokens.add(token)
  }
  const onDestroyed = (): void => {
    for (const key of frameLeases.keys()) revokeFrame(key)
  }
  input.contents.on('did-start-navigation', onNavigation)
  input.contents.on('destroyed', onDestroyed)
  return () => {
    input.contents.removeListener('did-start-navigation', onNavigation)
    input.contents.removeListener('destroyed', onDestroyed)
    onDestroyed()
    stopRevocations()
  }
}
