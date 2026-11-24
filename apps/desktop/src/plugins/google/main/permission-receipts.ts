import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export type PermissionReceipt = {
  /** An unsettled POST blocks all creates on this file. */
  pending: string | null
  /** These POSTs settled, but must not be replayed for an unverified guest. */
  acknowledged: string[]
}

/** One receipt per Drive file, shared by all vaults and accounts. The caller
 * holds the in-process file queue; Electron admits only one process per profile.
 * Do not discard these on account removal or impose an expiry: a timed-out
 * request may still be running at Drive.
 */
export function createPermissionReceipts(userData: string) {
  const pathFor = (fileId: string) => {
    const key = createHash('sha256').update(fileId).digest('hex')
    return join(userData, `google-drive-permission-${key}.json`)
  }

  async function syncDirectory() {
    // Node cannot open directories for fsync on Windows.
    if (process.platform === 'win32') return
    const dir = await open(userData, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }

  return {
    async read(fileId: string): Promise<PermissionReceipt> {
      let raw: string
      try {
        raw = await readFile(pathFor(fileId), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { pending: null, acknowledged: [] }
        throw error
      }
      const value = JSON.parse(raw) as string | Partial<PermissionReceipt> | null
      // The original receipt only stored the recipient, not a settled verdict.
      if (typeof value === 'string' && value) return { pending: value, acknowledged: [] }
      if (
        !value ||
        typeof value !== 'object' ||
        !(value.pending === null || (typeof value.pending === 'string' && value.pending)) ||
        !Array.isArray(value.acknowledged) ||
        !value.acknowledged.every((guest) => typeof guest === 'string' && guest)
      )
        throw new Error('Invalid Drive permission receipt')
      return { pending: value.pending, acknowledged: value.acknowledged }
    },
    async write(fileId: string, receipt: PermissionReceipt): Promise<void> {
      const path = pathFor(fileId)
      if (receipt.pending === null && !receipt.acknowledged.length) {
        await unlink(path)
        await syncDirectory()
        return
      }
      const temp = `${path}.${randomUUID()}.tmp`
      const file = await open(temp, 'wx', 0o600)
      try {
        try {
          await file.writeFile(JSON.stringify(receipt))
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temp, path)
        await syncDirectory()
      } finally {
        await unlink(temp).catch(() => {})
      }
    },
  }
}

export type PermissionReceipts = ReturnType<typeof createPermissionReceipts>
