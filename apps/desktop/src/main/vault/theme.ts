/**
 * Reads a vault's theme off disk and resolves it.
 *
 * Two optional files: `.holi/settings/theme.css` (committed) and
 * `.holi/settings/theme.local.css` (this machine only). `resolveTheme` in
 * `@holi/shared` does the merge, whitelist and validation; this module is only
 * the disk half, where a missing or unreadable file degrades to `null`.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  THEME_FILE,
  THEME_LOCAL_FILE,
  applyThemePatch,
  parseVaultTheme,
  replaceThemeMode,
  resolveTheme,
  type ResolvedTheme,
  type ThemeMode,
  type ThemePatch,
} from '@holi/shared'
import { HOLI_THEME_TEXT } from './seed/core'

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

/** Holi's own theme, both modes, as the Appearance pane's per-token reset and
 *  a mode reset write it. */
export function holiTheme(): { light: Record<string, string>; dark: Record<string, string> } {
  const parsed = parseVaultTheme(HOLI_THEME_TEXT)
  return { light: parsed?.light ?? {}, dark: parsed?.dark ?? {} }
}

/**
 * Reset one mode to Holi's theme: the shared file's block becomes
 * Holi's block for it and the local file's is emptied, so nothing overrides it.
 * The other mode is left alone. The running app follows through the watcher,
 * as for any write.
 */
export async function resetVaultTheme(root: string, mode: ThemeMode): Promise<void> {
  const holi = holiTheme()[mode]
  await Promise.all([
    writeThemeFile(join(root, THEME_FILE), (text) => replaceThemeMode(text, mode, holi)),
    writeThemeFile(join(root, THEME_LOCAL_FILE), (text) => replaceThemeMode(text, mode, {})),
  ])
}

/** Read, transform, write by rename, so a reader never sees half a file. */
async function writeThemeFile(abs: string, next: (text: string | null) => string): Promise<void> {
  const text = next(await readOrNull(abs))
  // `.holi/settings/` may not exist: a vault whose theme was never written, or
  // one someone tidied by hand. Harmless when it does.
  await mkdir(dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, abs)
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
  await writeThemeFile(abs, (text) => applyThemePatch(text, patch))
}
