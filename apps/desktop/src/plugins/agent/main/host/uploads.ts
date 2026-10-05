/**
 * Files a person attaches in the chat. Claude Code takes a file by its path,
 * so each is written into the vault, where the session can read it, and the
 * chat names it in the message as `@<path>`.
 *
 * They go under `.holi/state/chat.local.uploads/`: machine state, and a
 * `.local.` folder, so they are never committed or synced.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export const UPLOADS_DIR = '.holi/state/chat.local.uploads'

/** The most one file may weigh, decoded: it travels as one message to main. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export type UploadResult = { ok: true; path: string } | { ok: false; message: string }

/** A name safe to put in a path and a prompt: letters, digits, dots, dashes. */
function safeStem(name: string): string {
  const stem = basename(name, extname(name))
    .replace(/[^\p{L}\p{N}.-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
  return stem === '' ? 'file' : stem
}

/** The file's extension, kept so the session knows what it is: plain
 *  characters only, and none when the name has none. */
function safeExt(name: string): string {
  const ext = extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''
}

/** Write one attachment into the vault; answers its absolute path. */
export async function saveUpload(
  root: string,
  { name, data }: { name: string; data: string },
): Promise<UploadResult> {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) return { ok: false, message: 'That file is empty.' }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return { ok: false, message: 'That file is over 50 MB.' }
  }
  const dir = join(root, UPLOADS_DIR)
  const path = join(
    dir,
    `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}-${safeStem(name)}${safeExt(name)}`,
  )
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, bytes)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, path }
}
