export function installCancellationHandlers() {
  let interrupted = null
  let rejectCancellation
  const cancelled = new Promise((_, reject) => {
    rejectCancellation = reject
  })
  const onSignal = (signal) => {
    interrupted = signal
    rejectCancellation(new Error(`benchmark cancelled by ${signal}`))
  }
  const onInt = () => onSignal('SIGINT')
  const onTerm = () => onSignal('SIGTERM')
  process.once('SIGINT', onInt)
  process.once('SIGTERM', onTerm)
  cancelled.catch(() => {})
  return {
    get interrupted() {
      return interrupted
    },
    cancelled,
    dispose() {
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
    },
  }
}

export async function drainOwnedProcess(child, closed, { graceMs = 5000, killWaitMs = 1000 } = {}) {
  if (!child?.pid) return
  const group = process.platform === 'win32' ? child.pid : -child.pid
  const signal = (name) => {
    try {
      process.kill(group, name)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const groupAlive = () => {
    if (process.platform === 'win32') return false
    try {
      process.kill(group, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }

  signal('SIGTERM')
  if (closed) await Promise.race([closed.catch(() => {}), wait(graceMs)])
  signal('SIGKILL')
  await Promise.race([closed?.catch(() => {}) ?? Promise.resolve(), wait(killWaitMs)])
  if (groupAlive()) {
    await wait(killWaitMs)
    if (groupAlive()) throw new Error(`owned Electron process group ${child.pid} did not drain`)
  }
}
