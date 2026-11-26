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
