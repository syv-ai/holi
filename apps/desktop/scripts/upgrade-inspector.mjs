import assert from 'node:assert/strict'
import { once } from 'node:events'

function classifyProtocolError(code, message) {
  if (code === -32000) {
    switch (message) {
      case 'Cannot find default execution context':
        return 'default-context-missing'
      case 'Execution was terminated':
        return 'execution-terminated'
      case 'Promise was collected':
        return 'promise-collected'
      case 'Tearing down inspector/session/context':
        return 'inspector-teardown'
      case "Object couldn't be returned by value":
        return 'value-unserializable'
      case 'Object reference chain is too long':
        return 'value-too-deep'
    }
  }
  if (code === -32000 && /execution context was destroyed/i.test(message || ''))
    return 'context-destroyed'
  if (code === -32000 && /cannot find context/i.test(message || '')) return 'context-missing'
  if (code === -32000 && /target closed|session closed/i.test(message || '')) return 'target-closed'
  return 'protocol-error'
}

/** Caller owns the process: stop it before close unless deliberately resuming startup. */
export async function connectUpgradeInspector(record, { signal, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let url
  while (!url && Date.now() < deadline) {
    signal?.throwIfAborted()
    assert(record.child.exitCode === null, 'owned app exited before inspector connection')
    url = record.output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1]
    if (!url) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert(url, 'owned app inspector did not open before deadline')
  const socket = new WebSocket(url)
  const failure = new AbortController()
  const requests = new Map()
  const contexts = new Map()
  let nextId = 0
  let closed = false
  const observations = {
    entryContextDestroyed: false,
    contextsCleared: false,
    targetCrashed: false,
    targetDetached: false,
    debuggerDisconnected: false,
    childExit: null,
  }
  let entryContextId
  let frame
  let paused = true
  let resolvePause
  let rejectPause
  const pause = new Promise((resolve, reject) => {
    resolvePause = resolve
    rejectPause = reject
  })
  pause.catch(() => {})
  function refreshChildExit(exit) {
    if (observations.childExit !== null) return
    if (exit && (Number.isInteger(exit.code) || typeof exit.signal === 'string')) {
      observations.childExit = { code: exit.code, signal: exit.signal }
      return
    }
    const { exitCode, signalCode } = record.child
    if (Number.isInteger(exitCode) || typeof signalCode === 'string')
      observations.childExit = { code: exitCode, signal: signalCode }
  }
  function snapshot() {
    refreshChildExit()
    return {
      ...observations,
      entryContextId: Number.isInteger(entryContextId) ? entryContextId : null,
      childExit: observations.childExit && { ...observations.childExit },
    }
  }
  function fail(message) {
    const error = new Error(message)
    error.details = { method: null, kind: message, observations: snapshot() }
    failure.abort(error)
    for (const { reject, timer } of requests.values()) {
      clearTimeout(timer)
      reject(error)
    }
    requests.clear()
    rejectPause(error)
  }
  function onMessage(event) {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      fail('invalid inspector message')
      return
    }
    const pending = requests.get(message.id)
    if (pending) {
      requests.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        const error = new Error('inspector command rejected')
        error.details = {
          method: /^[A-Za-z]+\.[A-Za-z]+$/.test(pending.method) ? pending.method : null,
          code: Number.isInteger(message.error.code) ? message.error.code : null,
          kind: classifyProtocolError(message.error.code, message.error.message),
          observations: snapshot(),
        }
        pending.reject(error)
      } else pending.resolve(message.result)
    }
    if (
      message.method === 'Runtime.executionContextDestroyed' &&
      message.params?.executionContextId === entryContextId
    )
      observations.entryContextDestroyed = true
    if (message.method === 'Runtime.executionContextsCleared') {
      contexts.clear()
      observations.contextsCleared = true
    }
    if (message.method === 'Inspector.targetCrashed') observations.targetCrashed = true
    if (message.method === 'Target.detachedFromTarget') observations.targetDetached = true
    if (message.method === 'Debugger.scriptParsed' && !frame)
      contexts.set(message.params.scriptId, message.params.executionContextId)
    if (message.method === 'Debugger.paused') resolvePause(message.params)
  }
  const onAbort = () => fail('inspector operation aborted')
  const onClose = () => {
    if (!closed) {
      observations.debuggerDisconnected = true
      fail('inspector connection closed')
    }
  }
  const onError = () => fail('inspector connection failed')
  socket.addEventListener('message', onMessage)
  socket.addEventListener('close', onClose)
  socket.addEventListener('error', onError)
  signal?.addEventListener('abort', onAbort, { once: true })
  function close() {
    if (closed) return
    closed = true
    fail('inspector disposed')
    signal?.removeEventListener('abort', onAbort)
    socket.removeEventListener('message', onMessage)
    socket.removeEventListener('close', onClose)
    // Keep the error listener until the closing handshake settles.
    socket.close()
  }
  // A failed connection must not disconnect a paused app before its owner can
  // stop it. Its inspector is disposed once the actual owned process exits.
  record.exited.then((exit) => {
    refreshChildExit(exit)
    close()
  }, close)
  function command(method, params = {}) {
    signal?.throwIfAborted()
    failure.signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        requests.delete(id)
        const error = new Error('inspector command timed out')
        error.details = {
          method: /^[A-Za-z]+\.[A-Za-z]+$/.test(method) ? method : null,
          kind: 'timeout',
          timeoutMs,
          observations: snapshot(),
        }
        reject(error)
      }, timeoutMs)
      requests.set(id, { resolve, reject, timer, method })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch {
        clearTimeout(timer)
        requests.delete(id)
        const error = new Error('inspector send failed')
        error.details = {
          method: /^[A-Za-z]+\.[A-Za-z]+$/.test(method) ? method : null,
          kind: 'send-failed',
          observations: snapshot(),
        }
        reject(error)
      }
    })
  }
  await once(socket, 'open', {
    signal: AbortSignal.any(
      [signal, failure.signal, AbortSignal.timeout(timeoutMs)].filter(Boolean),
    ),
  })
  await command('Debugger.enable')
  await command('Runtime.enable')
  await command('Runtime.runIfWaitingForDebugger')
  let timer
  let state
  try {
    state = await Promise.race([
      pause,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('entry pause timed out')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  frame = state.callFrames?.[0]
  assert(frame && state.reason === 'Break on start', 'inspector did not pause at application entry')
  const contextId = contexts.get(frame.location.scriptId)
  assert(Number.isInteger(contextId), 'entry script execution context was not reported')
  entryContextId = contextId
  contexts.clear()
  return {
    frame: { ...frame, reason: state.reason },
    async evaluate(expression) {
      const resumed = !paused
      const evaluationId = `evaluation-${nextId + 1}`
      const evaluatedExpression = resumed
        ? `(() => {
            const roots = globalThis.__holiUpgradeEvaluationRoots ??= new Map();
            const value = Promise.resolve((require => eval(${JSON.stringify(expression)}))(globalThis.__holiUpgradeFixtureRequire));
            roots.set(${JSON.stringify(evaluationId)}, value);
            return value;
          })()`
        : expression
      let result
      try {
        result = await command(resumed ? 'Runtime.evaluate' : 'Debugger.evaluateOnCallFrame', {
          expression: evaluatedExpression,
          returnByValue: true,
          ...(paused ? { callFrameId: frame.callFrameId } : { awaitPromise: true, contextId }),
        })
      } finally {
        if (resumed && !failure.signal.aborted) {
          await command('Runtime.evaluate', {
            expression: `globalThis.__holiUpgradeEvaluationRoots?.delete(${JSON.stringify(evaluationId)})`,
            returnByValue: true,
            contextId,
          }).catch(() => {})
        }
      }
      if (result.exceptionDetails) {
        const error = new Error('fixture evaluation failed; native details withheld')
        error.details = {
          type: result.exceptionDetails.exception?.className,
          line: result.exceptionDetails.lineNumber,
          column: result.exceptionDetails.columnNumber,
        }
        throw error
      }
      return result.result?.value
    },
    async resume() {
      assert(paused, 'inspector session already resumed')
      const captured = await command('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression: 'globalThis.__holiUpgradeFixtureRequire = require; true',
        returnByValue: true,
      })
      assert(
        !captured.exceptionDetails && captured.result?.value === true,
        'fixture require capture failed',
      )
      await command('Debugger.resume')
      paused = false
    },
    close,
  }
}
