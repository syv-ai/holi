/**
 * Reads a vault's theme off disk and resolves it.
 *
 * Two optional files: `.holi/settings/theme.css` (committed) and
 * `.holi/settings/theme.local.css` (this machine only). `resolveTheme` in
 * `@holi/shared` does the merge, whitelist and validation; this module is only
 * the disk half, where a missing or unreadable file degrades to `null`.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  THEME_FILE,
  THEME_LOCAL_FILE,
  applyThemePatch,
  resolveTheme,
  type ResolvedTheme,
  type ThemePatch,
} from '@holi/shared'

/** The local one is gitignored (`*.local.*`); the watcher is taught to see it
 *  despite the local-only filter. */
export { THEME_FILE, THEME_LOCAL_FILE }

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
 * committed file going away is a real deletion that syncs to collaborators;
 * the local one is this machine's alone. Idempotent
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

/** Which of the two files an edit lands in. The pane offers the choice once for
 *  the whole section rather than per token: it is a fact about who the change
 *  is for, not about the colour. */
export type ThemeLayer = 'committed' | 'local'

/**
 * Apply a patch to one of a vault's theme files.
 *
 * **Read, merge, write, rename**: the file may carry tokens this pane never
 * touched, set by hand or by the agent, and a patch-only write would drop them.
 *
 * The running app follows on its own: the write fires the watcher, the renderer
 * re-reads, `useVaultTheme` re-applies. No channel, and no reload.
 */
export async function writeVaultTheme(
  root: string,
  layer: ThemeLayer,
  patch: ThemePatch,
): Promise<void> {
  if (patch.light === undefined && patch.dark === undefined) return
  const abs = join(root, layer === 'committed' ? THEME_FILE : THEME_LOCAL_FILE)
  const next = applyThemePatch(await readOrNull(abs), patch)
  // `.holi/settings/` may not exist: a vault whose theme was never written, or
  // one someone tidied by hand. Harmless when it does.
  await mkdir(dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp`
  await writeFile(tmp, next, 'utf8')
  await rename(tmp, abs)
}
