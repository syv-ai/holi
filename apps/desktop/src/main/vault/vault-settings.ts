/**
 * The synced vault config in `.holi/settings.json` (a `VAULT_CONFIG_FILES`
 * member — one policy for the whole vault). Deliberately minimal: today it holds
 * exactly one key the large-file gate needs. Anything wrong — no file, bad JSON,
 * a non-positive or non-numeric value — yields the default, because a corrupt
 * config must never break the commit path (mirrors `reminders/delivered-log.ts`).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_MAX_COMMITTED_FILE_BYTES } from './large-files'

/** The per-vault cap on a committed file's size, or the 10 MB default. */
export async function readMaxCommittedFileBytes(root: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(join(root, '.holi', 'settings.json'), 'utf8'))
    const value = (parsed as Record<string, unknown>)?.maxCommittedFileBytes
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  } catch {
    // absent or corrupt — fall through to the default
  }
  return DEFAULT_MAX_COMMITTED_FILE_BYTES
}
