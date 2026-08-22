/**
 * Reads a vault's settings off disk and resolves them.
 *
 * Two files, both optional: `.holi/settings.json` (committed, shared with
 * everyone who clones the vault) and `.holi/settings.local.json` (gitignored,
 * this machine only). The pure `resolveVaultSettings` (in `@holi/shared`) does
 * the merge + validation + defaulting; this module is only the disk half — a
 * missing or unreadable file degrades to `null`, never an error, so a vault with
 * no settings resolves to the defaults and the app behaves as it always did.
 *
 * Deliberately the same shape as `vault/theme.ts`, which does exactly this for
 * `.holi/theme.json`. Two files that differ only in which resolver they call
 * should not differ in anything else.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveVaultSettings, type ResolvedVaultSettings } from '@holi/shared'

/** The committed, shared settings — rides the normal watcher/snapshot path. */
export const SETTINGS_FILE = '.holi/settings.json'
/** The personal override — gitignored (`*.local.*`). Also where the reminder
 *  delivery watermark lives, which is why the resolver ignores keys it does not
 *  know rather than warning about them. */
export const SETTINGS_LOCAL_FILE = '.holi/settings.local.json'

async function readOrNull(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, 'utf8')
  } catch {
    return null
  }
}

/** Resolve `<root>`'s settings from its two files. Never throws. */
export async function readVaultSettings(root: string): Promise<ResolvedVaultSettings> {
  const [committed, local] = await Promise.all([
    readOrNull(join(root, SETTINGS_FILE)),
    readOrNull(join(root, SETTINGS_LOCAL_FILE)),
  ])
  return resolveVaultSettings(committed, local)
}
