import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

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
    async read(fileId: string): Promise<string | null> {
      let raw: string
      try {
        raw = await readFile(pathFor(fileId), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      const guest: unknown = JSON.parse(raw)
      if (typeof guest !== 'string' || !guest) throw new Error('Invalid Drive permission receipt')
      return guest
    },
    async begin(fileId: string, guest: string): Promise<void> {
      const path = pathFor(fileId)
      const temp = `${path}.${randomUUID()}.tmp`
      const file = await open(temp, 'wx', 0o600)
      try {
        try {
          await file.writeFile(JSON.stringify(guest.toLowerCase()))
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
    async clear(fileId: string): Promise<void> {
      await unlink(pathFor(fileId))
      await syncDirectory()
    },
  }
}

export type PermissionReceipts = ReturnType<typeof createPermissionReceipts>
