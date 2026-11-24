import { describe, expect, it, vi } from 'vitest'
import { createOwnedProcesses } from '../scripts/owned-processes.mjs'
import { connectUpgradeInspector } from '../scripts/upgrade-inspector.mjs'

class InspectorSocket extends EventTarget {
  static instance: InspectorSocket
  readyState = 0
  sent: { id: number; method: string; params: Record<string, unknown> }[] = []

  constructor() {
    super()
    InspectorSocket.instance = this
    queueMicrotask(() => {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    })
  }

  send(text: string) {
    const command = JSON.parse(text)
    this.sent.push(command)
    queueMicrotask(() => this.reply(command))
  }

  close() {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }

  emit(method: string, params: Record<string, unknown> = {}) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method, params }) }))
  }

  private reply(command: { id: number; method: string }) {
    if (command.method === 'Runtime.runIfWaitingForDebugger') {
      this.emit('Debugger.scriptParsed', { scriptId: 'entry-script', executionContextId: 7 })
      this.emit('Debugger.paused', {
        reason: 'Break on start',
        callFrames: [{ callFrameId: 'frame', location: { scriptId: 'entry-script' } }],
      })
    }
    const error =
      command.method === 'Runtime.evaluate'
        ? { code: -32602, message: 'sensitive protocol sentinel' }
        : undefined
    const result =
      command.method === 'Debugger.evaluateOnCallFrame' ? { result: { value: true } } : {}
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify(error ? { id: command.id, error } : { id: command.id, result }),
      }),
    )
  }
}

describe('upgrade inspector diagnostics', () => {
  it('redacts protocol messages and reports only destruction of the captured entry context', async () => {
    vi.stubGlobal('WebSocket', InspectorSocket)
    const record = {
      output: 'Debugger listening on ws://127.0.0.1:1234/devtools/page/1',
      child: { exitCode: null, signalCode: null },
      exited: new Promise(() => {}),
    }
    try {
      const inspector = await connectUpgradeInspector(record, { timeoutMs: 1000 })
      await inspector.resume()
      InspectorSocket.instance.emit('Runtime.executionContextDestroyed', { executionContextId: 99 })
      await expect(inspector.evaluate('sentinel')).rejects.toMatchObject({
        details: {
          method: 'Runtime.evaluate',
          kind: 'protocol-error',
          observations: { entryContextDestroyed: false },
        },
      })
      const error = await inspector.evaluate('sentinel').catch((reason) => reason)
      expect(JSON.stringify(error)).not.toContain('sensitive protocol sentinel')
      InspectorSocket.instance.emit('Runtime.executionContextDestroyed', { executionContextId: 7 })
      InspectorSocket.instance.emit('Inspector.targetCrashed')
      InspectorSocket.instance.emit('Target.detachedFromTarget')
      InspectorSocket.instance.emit('Runtime.executionContextsCleared')
      record.child.exitCode = 17
      record.child.signalCode = null
      const refreshed = await inspector.evaluate('sentinel').catch((reason) => reason)
      expect(refreshed.details.observations.childExit).toEqual({ code: 17, signal: null })
      InspectorSocket.instance.close()
      const disconnected = await inspector.evaluate('sentinel').catch((reason) => reason)
      expect(disconnected.details.observations).toMatchObject({
        entryContextDestroyed: true,
        contextsCleared: true,
        targetCrashed: true,
        targetDetached: true,
        debuggerDisconnected: true,
        childExit: { code: 17, signal: null },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps a signal exit observed from record.exited when disposal wins the socket-close race', async () => {
    vi.stubGlobal('WebSocket', InspectorSocket)
    let resolveExit!: (exit: { code: number | null; signal: string | null }) => void
    const record = {
      output: 'Debugger listening on ws://127.0.0.1:1234/devtools/page/1',
      child: { exitCode: null, signalCode: null },
      exited: new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        resolveExit = resolve
      }),
    }
    try {
      const inspector = await connectUpgradeInspector(record, { timeoutMs: 1000 })
      record.child.signalCode = 'SIGTERM'
      resolveExit({ code: null, signal: 'SIGTERM' })
      await record.exited
      await new Promise((resolve) => setTimeout(resolve, 0))
      const error = await inspector.evaluate('sentinel').catch((reason) => reason)
      expect(error.details.observations.childExit).toEqual({ code: null, signal: 'SIGTERM' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports a bounded Runtime.evaluate timeout without exposing the expression', async () => {
    const owned = createOwnedProcesses()
    const record = owned.start(process.execPath, [
      '--inspect-brk=127.0.0.1:0',
      '-e',
      'setInterval(() => {}, 1000)',
    ])
    let inspector: Awaited<ReturnType<typeof connectUpgradeInspector>> | undefined
    const expression = 'globalThis.secretFixtureExpression; new Promise(() => {})'
    try {
      inspector = await connectUpgradeInspector(record, { timeoutMs: 1500 })
      await inspector.resume()
      await expect(inspector.evaluate(expression)).rejects.toMatchObject({
        details: {
          method: 'Runtime.evaluate',
          kind: 'timeout',
          timeoutMs: 1500,
          observations: expect.objectContaining({
            entryContextDestroyed: false,
            childExit: null,
          }),
        },
        message: expect.not.stringContaining(expression),
      })
    } finally {
      await owned.stop(record)
      inspector?.close()
      await record.exited
      expect(owned.remainingPids).toEqual([])
    }
  }, 10_000)
})
