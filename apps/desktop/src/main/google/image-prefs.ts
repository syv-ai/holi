/**
 * Senders whose remote images always load.
 *
 * Blocking remote content is the default (see `renderer/src/lib/mail-html.ts`):
 * an image fetched from a sender's server is a read receipt nobody agreed to.
 * This holds the *exceptions*: addresses the user has decided they do not mind
 * telling.
 *
 * **On disk rather than in memory**, unlike the per-message "load images"
 * choice: "always from Jane" is a standing decision about a person and would be
 * worthless if it evaporated on restart.
 *
 * Plain JSON, unencrypted, like `calendar-prefs.ts`: there is no credential here.
 *
 * **Addresses are lowercased on the way in.** `Jane@Syv.ai` and `jane@syv.ai`
 * are one person; matching case-sensitively would silently re-block a sender
 * the user had already allowed.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface ImagePrefsStore {
  /** Lowercased addresses. Order is not meaningful. */
  read(): Promise<string[]>
  allow(sender: string): Promise<void>
  /** Forget every exception. The only way back to "block everything": a
   *  standing permission the user cannot see or revoke is not one they gave. */
  clear(): Promise<void>
}

export function createImagePrefs(path: string): ImagePrefsStore {
  const read = async (): Promise<string[]> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      // Not written yet: nothing is allowed, which is the safe default.
      return []
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      // A hand-edit gone wrong drops the bad entry rather than the file, which
      // would re-block every sender the user allowed.
      return parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== '')
    } catch {
      // A corrupt file costs the exceptions, never the mail. Blocking is the
      // safe direction to fail in.
      return []
    }
  }

  const write = async (senders: string[]): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    // Written aside and renamed: a crash mid-write must not leave a truncated
    // file, which `read` would discard along with every other exception.
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify(senders, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }

  return {
    read,
    async allow(sender) {
      const normalised = sender.trim().toLowerCase()
      // An empty address is what `parseAddress` produces for a `From` header it
      // could not read. Storing it would allow images for every such message.
      if (normalised === '') return
      const current = await read()
      if (current.includes(normalised)) return
      await write([...current, normalised])
    },
    async clear() {
      await write([])
    },
  }
}
