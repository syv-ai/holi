import { openSync, writeSync, closeSync } from 'node:fs'

export function createCredentialLog(path, limit = 2 * 1024 * 1024) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid log byte limit')
  const fd = openSync(path, 'wx', 0o600)
  let observedBytes = 0
  let retainedBytes = 0
  return {
    write(data) {
      const bytes = Buffer.from(data)
      observedBytes += bytes.length
      const retained = bytes.subarray(0, Math.max(0, limit - retainedBytes))
      let offset = 0
      while (offset < retained.length)
        offset += writeSync(fd, retained, offset, retained.length - offset)
      retainedBytes += retained.length
    },
    close() {
      closeSync(fd)
      return { limit, observedBytes, retainedBytes, truncated: observedBytes > retainedBytes }
    },
  }
}
