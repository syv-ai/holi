/**
 * Reads a vault's theme off disk and resolves it.
 *
 * Two files, both optional: `.holi/theme.json` (committed, shared with everyone
 * who clones the vault) and `.holi/theme.local.json` (gitignored, this machine
 * only). The pure `resolveTheme` (in `@holi/shared`) does the merge + whitelist
 * + validation; this module is only the disk half — a missing or unreadable
 * file degrades to `null`, never an error, so a vault with no theme resolves to
 * the empty theme and the app falls back to its defaults.
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveTheme, type ResolvedTheme } from '@holi/shared'

/** The committed, shared theme — rides the normal watcher/snapshot path. */
export const THEME_FILE = '.holi/theme.json'
/** The personal override — gitignored (`*.local.*`); the watcher is taught to
 *  see it despite the local-only filter (see `watcher.ts`). */
export const THEME_LOCAL_FILE = '.holi/theme.local.json'

async function readOrNull(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, 'utf8')
  } catch {
    return null
  }
}

/** Resolve `<root>`'s theme from its two files. Never throws. */
export async function readVaultTheme(root: string): Promise<ResolvedTheme> {
  const [committed, local] = await Promise.all([
    readOrNull(join(root, THEME_FILE)),
    readOrNull(join(root, THEME_LOCAL_FILE)),
  ])
  return resolveTheme(committed, local)
}

/**
 * Reset the vault to the standard look by removing both theme files. The
 * committed `theme.json` going away is a real deletion that syncs to
 * collaborators; `theme.local.json` is this machine's alone. Idempotent
 * (`force`), so resetting an already-standard vault is a no-op. The running app
 * reverts on its own: the unlink fires the watcher → rescan → the renderer
 * re-reads and finds nothing to apply.
 */
export async function resetVaultTheme(root: string): Promise<void> {
  await Promise.all([
    rm(join(root, THEME_FILE), { force: true }),
    rm(join(root, THEME_LOCAL_FILE), { force: true }),
  ])
}
