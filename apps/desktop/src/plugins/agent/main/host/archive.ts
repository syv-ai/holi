/**
 * Which of a vault's chats are archived: hidden from the stack of bubbles and
 * kept in the history, from where they come back or are deleted.
 *
 * Holi's own record, by job id, in the vault's machine state (a `.local.`
 * file, so never committed): Claude Code has no such thing as an archived
 * session, only live ones and finished ones.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const ARCHIVE_FILE = '.holi/state/archive.local.json'

/** The archived job ids. A missing or unreadable file is an empty archive. */
export async function readArchive(root: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, ARCHIVE_FILE), 'utf8'))
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id !== '')
      : []
  } catch {
    return []
  }
}

export async function writeArchive(root: string, ids: Iterable<string>): Promise<void> {
  const path = join(root, ARCHIVE_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify([...ids], null, 2)}\n`, 'utf8')
}
