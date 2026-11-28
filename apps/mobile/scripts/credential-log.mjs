import { constants } from 'node:os'

export function credentialFailure(error, signal) {
  return {
    status: error?.timedOut === true ? 'timeout' : signal?.aborted ? 'interrupted' : 'failed',
    exitCode:
      Number.isInteger(error?.exitCode) && error.exitCode >= 0 && error.exitCode <= 255
        ? error.exitCode
        : null,
    signal:
      typeof error?.signal === 'string' && Object.hasOwn(constants.signals, error.signal)
        ? error.signal
        : null,
    filesystemError: ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? error.code : null,
  }
}

/** Record only command outcomes. Output, arguments and exception messages are not evidence. */
export async function recordCredentialCommand(receipts, stage, work, signal) {
  const start = performance.now()
  const record = (result) =>
    receipts.push({ stage, ...result, durationMs: Math.round(performance.now() - start) })
  try {
    const stdout = await work()
    record({ status: 'ok', exitCode: 0, signal: null })
    return stdout
  } catch (error) {
    record(credentialFailure(error, signal))
    throw error
  }
}
