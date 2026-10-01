/**
 * Senders whose remote images always load.
 *
 * Blocking remote content is the default (see `renderer/mail-html.ts`):
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
import { jsonFileStore } from '../../../main/plugin-api'

export interface ImagePrefsStore {
  /** Lowercased addresses. Order is not meaningful. */
  read(): Promise<string[]>
  allow(sender: string): Promise<void>
  /** Forget every exception. The only way back to "block everything": a
   *  standing permission the user cannot see or revoke is not one they gave. */
  clear(): Promise<void>
}

/** Not written yet, or corrupt: nothing is allowed. A corrupt file costs the
 *  exceptions, never the mail; blocking is the safe direction to fail in. */
function parseSenders(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) return []
  // A hand-edit gone wrong drops the bad entry rather than the file, which
  // would re-block every sender the user allowed.
  return parsed
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
}

export function createImagePrefs(path: string): ImagePrefsStore {
  const store = jsonFileStore(path, parseSenders)
  return {
    read: store.read,
    async allow(sender) {
      const normalised = sender.trim().toLowerCase()
      // An empty address is what `parseAddress` produces for a `From` header it
      // could not read. Storing it would allow images for every such message.
      if (normalised === '') return
      await store.update((current) =>
        current.includes(normalised) ? current : [...current, normalised],
      )
    },
    async clear() {
      await store.update(() => [])
    },
  }
}
