import type { WebContents } from 'electron'
import { createFrameContextCancellation } from './frame-context-cancellation'

type ProtocolEvent = (method: string, params: any, sessionId?: string) => void

/** Private owner of one WebContents debugger attachment and its flattened sessions. */
export function createFrameContextSessionOwner(
  contents: WebContents,
  onProtocolEvent: ProtocolEvent,
  onInvalidate: () => void,
) {
  const client = contents.debugger
  const initialized = new Set<string>()
  const attached = new Set<string>()
  const setups = new Map<string, Promise<void>>()
  const sessionCancellations = new Map<string, ReturnType<typeof createFrameContextCancellation>>()
  let owns = false
  let terminal = false
  let disposed = false
  let epoch = 0
  const cancellation = createFrameContextCancellation()
  const identity = (sessionId?: string) => sessionId ?? ''

  const assertAvailable = () => {
    if (disposed || terminal) throw new Error('frame addressing is no longer available')
    if (!owns || !client.isAttached()) {
      fail('debugger ownership was lost')
      throw new Error('debugger ownership was lost')
    }
  }
  const send = async (
    method: string,
    params?: object,
    sessionId?: string,
    failOnCommandError = true,
  ) => {
    assertAvailable()
    const before = epoch
    const sessionCancellation =
      sessionId === undefined || sessionId === ''
        ? undefined
        : sessionCancellations.get(sessionId)
    try {
      if (sessionId && !sessionCancellation)
        throw new Error('debugger session is no longer available')
      const command =
        sessionId === undefined || sessionId === ''
          ? client.sendCommand(method, params)
          : client.sendCommand(method, params, sessionId)
      const result = await (sessionCancellation ?? cancellation).run(command)
      assertAvailable()
      if (before !== epoch) throw new Error('debugger epoch changed during command')
      return result
    } catch (error) {
      const detachedSession =
        sessionCancellation !== undefined &&
        sessionCancellations.get(sessionId!) !== sessionCancellation
      if (failOnCommandError && !detachedSession) fail('debugger command failed')
      throw error
    }
  }
  const fail = (reason: string) => {
    if (terminal) return
    terminal = true
    const error = new Error(reason || 'debugger ownership was lost')
    cancellation.cancel(error)
    for (const sessionCancellation of sessionCancellations.values())
      sessionCancellation.cancel(error)
    sessionCancellations.clear()
    invalidate()
    client.removeListener('message', onMessage)
    client.removeListener('detach', onDetach)
    const release = owns && client.isAttached()
    owns = false
    if (release) {
      try {
        client.detach()
      } catch {
        // Ownership is already invalidated; a failed detach cannot restore it.
      }
    }
  }
  function invalidate() {
    epoch++
    initialized.clear()
    setups.clear()
    attached.clear()
    onInvalidate()
  }
  async function initializeSession(sessionId?: string): Promise<void> {
    const id = identity(sessionId)
    if (initialized.has(id)) return
    assertAvailable()
    const startEpoch = epoch
    await send('Runtime.enable', {}, sessionId)
    await send('Debugger.enable', {}, sessionId)
    await send('Page.enable', {}, sessionId)
    await send('DOM.enable', {}, sessionId)
    await send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [
          { type: 'page', exclude: false },
          { type: 'iframe', exclude: false },
        ],
      },
      sessionId,
    )
    if (startEpoch !== epoch)
      throw new Error('debugger epoch changed during session initialization')
    if (sessionId !== undefined && !attached.has(sessionId)) return
    initialized.add(id)
  }
  async function ensureReady() {
    if (disposed || terminal) throw new Error('frame addressing is no longer available')
    if (!owns) {
      if (client.isAttached()) throw new Error('refusing to attach to an existing debugger')
      client.attach('1.3')
      epoch++
      owns = true
      client.on('message', onMessage)
      client.on('detach', onDetach)
    }
    if (!initialized.has('')) await initializeSession()
    while (true) {
      const pending = [...setups.entries()]
      if (!pending.length) break
      await Promise.all(pending.map(([, setup]) => setup))
      for (const [id, setup] of pending) if (setups.get(id) === setup) setups.delete(id)
    }
    assertAvailable()
  }
  const onMessage = (_event: unknown, method: string, params: any, session?: string) => {
    session = session || undefined
    if (terminal || disposed) return
    if (method === 'Target.attachedToTarget') {
      const id = params.sessionId
      const type = params.targetInfo?.type
      if (typeof id === 'string' && typeof type === 'string') {
        if (type !== 'iframe' && type !== 'page') {
          void send('Target.detachFromTarget', { sessionId: id }, session).catch(() => {})
        } else if (!attached.has(id)) {
          attached.add(id)
          sessionCancellations.set(id, createFrameContextCancellation())
          const setup = initializeSession(id)
          setups.set(id, setup)
          void setup.catch(() => {})
        }
      }
    } else if (method === 'Target.detachedFromTarget') {
      const id = params.sessionId
      attached.delete(id)
      initialized.delete(id)
      setups.delete(id)
      sessionCancellations.get(id)?.cancel(new Error('debugger session detached'))
      sessionCancellations.delete(id)
    }
    onProtocolEvent(method, params, session)
  }
  const onDetach = () => {
    // Clear ownership before callbacks can attach a replacement client.
    owns = false
    fail('debugger detached')
  }
  function dispose() {
    if (disposed) return
    disposed = true
    terminal = true
    const error = new Error('frame addressing is no longer available')
    cancellation.cancel(error)
    for (const sessionCancellation of sessionCancellations.values())
      sessionCancellation.cancel(error)
    sessionCancellations.clear()
    invalidate()
    client.removeListener('message', onMessage)
    client.removeListener('detach', onDetach)
    const release = owns && client.isAttached()
    owns = false
    if (release) client.detach()
  }

  return Object.freeze({
    ensureReady,
    assertAvailable,
    send,
    fail,
    dispose,
    get epoch() {
      return epoch
    },
    get owned() {
      return owns
    },
    get terminal() {
      return terminal
    },
    run: cancellation.run,
    get pendingCount() {
      return cancellation.pendingCount
    },
  })
}
