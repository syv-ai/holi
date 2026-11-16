import type { WebContents, WebFrameMain } from 'electron'

export interface SenderEvent {
  readonly sender: WebContents
  readonly senderFrame: WebFrameMain | null
}

/** Authorizes one message from the current Holi document, not merely its origin. */
export function isApplicationSender(
  event: SenderEvent,
  current: WebContents | null,
  entryDocument: string | null,
): boolean {
  try {
    if (current === null || entryDocument === null || current.isDestroyed()) return false
    if (event.sender !== current) return false

    const frame = event.senderFrame
    if (frame === null || frame !== current.mainFrame || frame.detached || frame.parent !== null) {
      return false
    }

    const actual = new URL(frame.url)
    const expected = new URL(entryDocument)
    if (
      actual.protocol !== expected.protocol ||
      actual.hostname !== expected.hostname ||
      actual.port !== expected.port ||
      actual.pathname !== expected.pathname ||
      actual.username !== '' ||
      actual.password !== '' ||
      expected.username !== '' ||
      expected.password !== ''
    ) {
      return false
    }
    // Only configured local application documents are acceptable. Query and
    // fragment are intentionally not pinned: the renderer uses both at runtime.
    return (
      (expected.protocol === 'file:' && actual.host === expected.host) ||
      (['http:', 'https:'].includes(expected.protocol) && actual.origin === expected.origin)
    )
  } catch {
    return false
  }
}

export function unauthorizedApplicationSender(): Error {
  return new Error('IPC is available only to the current Holi application document')
}
