import { randomBytes } from 'node:crypto'
import type { WebFrameMain } from 'electron'
import type { FrameContext } from './frame-context-metadata'

interface ProbeMetadata {
  lookup(sessionId: string | undefined, contextId: number): FrameContext | undefined
}

interface ProbeOwner {
  readonly epoch: number
  readonly terminal: boolean
  run<T>(operation: PromiseLike<T>): Promise<T>
  send(method: string, params?: object, sessionId?: string): Promise<unknown>
  fail(reason: string): void
}

type PendingProbe = {
  nonce: string
  source: string
  epoch: number
  pause?: FrameContext
  scripts: Map<string, number>
}

const sessionKey = (sessionId?: string) => sessionId ?? ''

/** Correlates host-random default-world probes with their exact native CDP pause. */
export function createFrameContextNativeProbes(owner: ProbeOwner, metadata: ProbeMetadata) {
  const pending = new Map<string, PendingProbe>()

  async function probe(frame: WebFrameMain, current: () => void): Promise<FrameContext> {
    current()
    const nonce = randomBytes(24).toString('hex')
    const item: PendingProbe = {
      nonce,
      source: `holi-frame-probe://${nonce}`,
      epoch: owner.epoch,
      scripts: new Map(),
    }
    pending.set(nonce, item)
    try {
      await owner.run(frame.executeJavaScript(`debugger;\n//# sourceURL=${item.source}`))
      current()
      if (pending.get(nonce) !== item || !item.pause)
        throw new Error('private native frame probe was not uniquely observed')
      return item.pause
    } finally {
      if (pending.get(nonce) === item) pending.delete(nonce)
    }
  }

  function acceptProtocolEvent(method: string, params: any, sessionId?: string) {
    if (method === 'Debugger.scriptParsed') {
      for (const item of pending.values())
        if (
          item.epoch === owner.epoch &&
          item.source === params.url &&
          typeof params.scriptId === 'string' &&
          typeof params.executionContextId === 'number'
        )
          item.scripts.set(
            `${sessionKey(sessionId)}\0${params.scriptId}`,
            params.executionContextId,
          )
    } else if (method === 'Debugger.paused') {
      const scriptId = params.callFrames?.[0]?.location?.scriptId
      const item = [...pending.values()].find(
        (candidate) =>
          candidate.epoch === owner.epoch &&
          candidate.scripts.has(`${sessionKey(sessionId)}\0${scriptId}`),
      )
      const contextId = item?.scripts.get(`${sessionKey(sessionId)}\0${scriptId}`)
      const context = contextId === undefined ? undefined : metadata.lookup(sessionId, contextId)
      if (!item || !context || item.pause) {
        owner.fail('unowned or ambiguous debugger pause')
        return
      }
      item.pause = context
      void owner.send('Debugger.resume', {}, sessionId).catch(() => {})
    } else if (method === 'Target.detachedFromTarget') {
      pruneSession(params.sessionId)
    }
  }

  function pruneSession(sessionId: string) {
    const prefix = `${sessionId}\0`
    for (const [nonce, item] of pending) {
      for (const key of [...item.scripts.keys()])
        if (key.startsWith(prefix)) item.scripts.delete(key)
      if (!item.scripts.size) pending.delete(nonce)
    }
  }

  function clear() {
    pending.clear()
  }

  return Object.freeze({ probe, acceptProtocolEvent, pruneSession, clear })
}
