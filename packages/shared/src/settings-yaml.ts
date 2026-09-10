/**
 * Reading and writing a settings file that explains itself.
 *
 * **Why YAML.** `.holi/settings/app.yaml` said nothing about what a key meant.
 * The settings tab knew — every setting carries a label and an explanation in
 * `VAULT_SETTINGS` — but somebody opening the file by hand, or the agent
 * editing it, saw six bare keys. The explanations now go into the file, and
 * they are generated from the same schema the tab renders, so the two cannot
 * disagree.
 *
 * YAML rather than JSONC or a `$schema` key because it is already the vault's
 * idiom for anything a person writes: note frontmatter is YAML, a vault app is
 * described by `app.yaml`, and the editor has a YAML mode. It also costs no new
 * dependency — `yaml` is already a direct dependency of both packages.
 *
 * **Two properties this module exists to guarantee:**
 *
 * 1. **A write never destroys a comment**, generated or hand-written. Every
 *    write goes `parseDocument` → `set` → `toString`, so the document survives
 *    the round trip. Stringifying a plain object would silently delete anything
 *    a person had added, once, permanently.
 * 2. **A read accepts the old file too.** YAML is a superset of JSON, so a
 *    `.json` file parses here unchanged. The migration renames; it does not
 *    have to translate, and a vault mid-migration is never unreadable.
 */
import { parseDocument } from 'yaml'
import { VAULT_SETTINGS } from './vault-settings'
import { mergeYamlDocument } from './yaml-document'

/**
 * Parse a settings file into a plain object.
 *
 * Anything that is not a mapping reads as "no settings" — a half-written file
 * must not stop a vault opening, which is the same rule the JSON reader had.
 */
export function parseSettingsText(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === '') return {}
  try {
    const value: unknown = parseDocument(text).toJS()
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** The comment a key gets, from the schema. `undefined` for a key no setting
 *  describes — the local file's `reminders` watermark, say, which is machine
 *  state and has nothing to explain. */
function settingComment(path: readonly string[]): string | undefined {
  if (path.length !== 1) return undefined
  const setting = VAULT_SETTINGS.find((s) => s.key === path[0])
  return setting === undefined ? undefined : `${setting.label}\n${setting.explanation}`
}

/**
 * Merge a patch into a settings file's text, keeping the document.
 *
 * `existing` is the file as it was read, or `null` for one that does not exist
 * yet. Returns the whole file to write. See `yaml-document.ts` for why this is
 * a merge into the document rather than a stringify.
 */
export function writeSettingsText(
  existing: string | null,
  patch: Record<string, unknown>,
): string {
  return mergeYamlDocument(existing, patch, settingComment)
}

/**
 * A fresh file holding exactly these values, fully commented.
 *
 * What the seed writes. Separate from `writeSettingsText(null, …)` only in
 * saying so at the call site: a seed is not a merge into nothing.
 */
export function seedSettingsText(values: Record<string, unknown>): string {
  return writeSettingsText(null, values)
}
