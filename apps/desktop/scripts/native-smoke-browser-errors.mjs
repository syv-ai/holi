export function isBrowserRuntimeError(message) {
  if (message.method === 'Runtime.exceptionThrown') return true
  return message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error'
}

export function assertNoBrowserRuntimeErrors(errors) {
  if (errors.length > 0)
    throw new Error(
      `renderer emitted uncaught exceptions or console.error calls: ${JSON.stringify(errors)}`,
    )
}
