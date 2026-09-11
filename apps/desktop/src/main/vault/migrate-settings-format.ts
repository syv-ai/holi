/**
 * `.holi/settings/*.json` becomes `*.yaml`, once, per vault.
 *
 * **A conversion, not a rename, which is why it is not in `migrate-layout.ts`.**
 * That module's `MOVES` table is a list of paths whose left column is a
 * deliberately dead literal; this one has to read each file, re-serialise it,
 * and write it somewhere else. Mixing the two would put a parser inside a table
 * of strings.
 *
 * **Every file is rewritten through its own writer**, so the result is not JSON
 * with a new extension: it comes out as block YAML carrying the explanations
 * generated from `VAULT_SETTINGS` and the theme token notes. That is the whole
 * point of the format change, and a vault that only got renamed would keep none
 * of it until somebody happened to touch a control.
 *
 * **Never throws, and never clobbers.** This runs on the way into a vault; a
 * file that is absent, unreadable, or already converted is skipped. A `.yaml`
 * that already exists wins over the `.json` beside it — the new file is the one
 * the app has been writing.
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  themeFromLegacy,
  ICONS_FILE,
  ICONS_LOCAL_FILE,
  parseSettingsText,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  THEME_FILE,
  THEME_LOCAL_FILE,
  writeSettingsText,
} from '@holi/shared'

/** Re-serialise one file's text into its YAML form. */
type Convert = (text: string) => string

/**
 * `<old .json>` → `<new .yaml>`, with the writer that owns that file's shape.
 *
 * The left column is a dead literal for the same reason `migrate-layout.ts`
 * says: written in terms of today's constants it would describe a move from a
 * place to itself, and a project-wide rename has already done exactly that to
 * one such table.
 */
const CONVERSIONS: readonly (readonly [string, string, Convert])[] = [
  // Settings: parsed to values and written fresh, so every key gains its
  // explanation. Siblings this app does not own (`reminders` in the local file)
  // ride along because the whole parsed object is handed back.
  [
    '.holi/settings/app.json',
    SETTINGS_FILE,
    (t) => writeSettingsText(parseSettingsText(t), 'committed'),
  ],
  [
    '.holi/settings/app.local.json',
    SETTINGS_LOCAL_FILE,
    (t) => writeSettingsText(parseSettingsText(t), 'local'),
  ],
  // Theme: read in the OLD shape and written as CSS, because a theme is a set
  // of custom properties and the file now says so. `themeFromLegacy`, never
  // `applyThemePatch` — the live reader speaks CSS, so handing it a YAML theme
  // would read as empty and quietly replace a vault's colours with defaults.
  //
  // Both hops are listed. A vault may sit at `.json` (never opened since the
  // YAML change) or at `.yaml` (opened once in between), and a table that knew
  // only the older one would strand every vault caught in the middle.
  ['.holi/settings/theme.json', THEME_FILE, themeFromLegacy],
  ['.holi/settings/theme.local.json', THEME_LOCAL_FILE, themeFromLegacy],
  ['.holi/settings/theme.yaml', THEME_FILE, themeFromLegacy],
  ['.holi/settings/theme.local.yaml', THEME_LOCAL_FILE, themeFromLegacy],
  // Icons: no metadata to add, so this is only a reformat. One entry per path,
  // and a path explains itself.
  ['.holi/settings/icons.json', ICONS_FILE, (t) => stringifyYaml(parseYaml(t) ?? {})],
  ['.holi/settings/icons.local.json', ICONS_LOCAL_FILE, (t) => stringifyYaml(parseYaml(t) ?? {})],
]

/** Convert whatever is still JSON. Returns what it converted. */
export async function migrateSettingsFormat(root: string): Promise<string[]> {
  const converted: string[] = []
  for (const [from, to, convert] of CONVERSIONS) {
    try {
      const text = await readFile(join(root, from), 'utf8')
      // The new file wins: it is the one the app has been writing since the
      // move, and overwriting it with an older JSON would undo real edits.
      const already = await readFile(join(root, to), 'utf8').catch(() => null)
      if (already === null) await writeFile(join(root, to), convert(text), 'utf8')
      await rm(join(root, from), { force: true })
      converted.push(to)
    } catch {
      // Absent, already converted, or unreadable. All three mean: carry on.
    }
  }
  return converted
}
