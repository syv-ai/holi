export function createCdpClient(socket, { onEvent = () => {}, timeoutMs = 10000 } = {}) {
  let nextId = 0
  const pending = new Map()
  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      clearTimeout(request.timer)
      message.error
        ? request.reject(new Error(message.error.message))
        : request.resolve(message.result)
      return
    }
    onEvent(message)
  })
  socket.addEventListener('close', () => rejectPending(new Error('CDP socket closed')))
  socket.addEventListener('error', () => rejectPending(new Error('CDP socket error')))

  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })

  const attach = async (targetId) => {
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
    return {
      call: (method, params = {}) => call(method, params, sessionId),
      evaluate: async (expression) => {
        const result = await call(
          'Runtime.evaluate',
          {
            expression,
            returnByValue: true,
            awaitPromise: true,
          },
          sessionId,
        )
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
        return result.result.value
      },
    }
  }

  return { call, attach, close: () => rejectPending(new Error('CDP client closed')) }
}
