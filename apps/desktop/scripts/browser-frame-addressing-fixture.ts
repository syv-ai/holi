import { randomUUID } from 'node:crypto'
import type { WebContents, WebFrameMain } from 'electron'

export function fixtureFrames(contents: WebContents): WebFrameMain[] {
  const result: WebFrameMain[] = []
  const visit = (parent: WebFrameMain) => {
    for (const frame of parent.frames) {
      result.push(frame)
      visit(frame)
    }
  }
  visit(contents.mainFrame)
  return result
}

export async function waitForFixtureFrames(
  getFrames: () => WebFrameMain[],
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const frames = getFrames()
    if (frames.length === count && frames.every((frame) => frame.url.startsWith('http://'))) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`fixture iframe tree did not settle at ${count} frames`)
}

/** Independently maps a native handle to its embedding element through postMessage source identity. */
export async function fixtureEmbeddingId(frame: WebFrameMain): Promise<string> {
  const parent = frame.parent
  if (!parent) throw new Error('fixture frame has no embedding parent')
  const token = `fixture-owner-${randomUUID()}`
  const key = `__holiFixtureOwner_${token.replace(/[^a-zA-Z0-9]/g, '')}`
  const encodedKey = JSON.stringify(key)
  const encodedToken = JSON.stringify(token)
  try {
    // executeJavaScript resolves after this synchronous setup has installed the listener.
    await parent.executeJavaScript(`(() => {
      const state = { receive: null, timer: null, promise: null }
      state.promise = new Promise((resolve, reject) => {
        state.timer = setTimeout(() => {
          window.removeEventListener('message', state.receive)
          reject(new Error('owner observation timed out'))
        }, 5000)
        state.receive = function receive(event) {
          if (event.data?.token !== ${encodedToken}) return
          window.removeEventListener('message', state.receive)
          clearTimeout(state.timer)
          const owner = Array.from(document.querySelectorAll('iframe')).find((element) => element.contentWindow === event.source)
          resolve(owner?.id ?? '')
        }
        window.addEventListener('message', state.receive)
      })
      window[${encodedKey}] = state
    })()`)
    await frame.executeJavaScript(`parent.postMessage({token:${encodedToken}}, '*')`)
    const id = await parent.executeJavaScript(`window[${encodedKey}].promise`)
    if (typeof id !== 'string' || !id)
      throw new Error('fixture could not independently identify embedding element')
    return id
  } finally {
    try {
      await parent.executeJavaScript(`(() => {
        const state = window[${encodedKey}]
        if (!state) return
        clearTimeout(state.timer)
        window.removeEventListener('message', state.receive)
        delete window[${encodedKey}]
      })()`)
    } catch {
      // Navigation can destroy the parent execution context before cleanup runs.
    }
  }
}
