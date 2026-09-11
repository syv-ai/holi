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
import { parseDocument, stringify as stringifyYaml } from 'yaml'
import {
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  VAULT_SETTINGS,
  type SettingTarget,
  type SettingType,
} from './vault-settings'

/**
 * Parse a settings file into a plain object.
 *
 * Anything that is not a mapping reads as "no settings" — a half-written file
 * must not stop a vault opening, which is the same rule the JSON reader had.
 */
export function parseSettingsText(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === '') return {}
  try {
    const doc = parseDocument(text)
    // **Errors as well as shape.** `parseDocument` does not throw on a broken
    // file; it records the error and still hands back a map, so `{ not json`
    // reads as the key `not json`. `mergeYamlDocument` used to catch that on
    // the way out, which stopped being the write path's job when the writer
    // started generating the document instead of merging into one — and a
    // reader that returns a key nobody typed was always the more honest place
    // to refuse it.
    if (doc.errors.length > 0) return {}
    const value: unknown = doc.toJS()
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Every legal value for a setting, as the file should show them.
 *
 * **The options, not the type name.** "One of: mono, sans, serif" is what a
 * person or the agent needs at the moment they are typing; "an EditorFont" is
 * a word that sends them somewhere else to find out. Derived from `SettingType`
 * so a control, a validator and this line cannot offer three different answers.
 */
function legalValues(type: SettingType): string[] {
  if (type.kind === 'boolean') return ['One of: true, false']
  if (type.kind === 'flags') {
    return ['Each one is true or false. Naming one says nothing about the others.']
  }
  const shown = type.options.map((o) => `${inline(o.value)} (${o.label})`).join(', ')
  if (type.kind === 'number') {
    // The options are what the PANE offers; the validator takes any positive
    // number, and a file saying 7 MB is a good answer. Saying so here is what
    // stops this list reading as the whole legal range.
    return [`Any positive number of bytes. What the pane offers: ${shown}`]
  }
  if (type.kind === 'enum') return [`One of: ${shown}`]
  // `parsed` — `landing`, whose value is an object and two of whose four shapes
  // are deliberately not offered by the pane.
  return [`One of: ${shown}`, `Or anything else that is ${type.expected}, written by hand.`]
}

/**
 * A value small enough to sit on its key's line: `mono`, `{ kind: daily }`.
 *
 * **A map has to be written in flow style here, not block.** `stringify` gives
 * a one-entry map back as `kind: daily`, which is correct YAML on its own and
 * becomes `landing: kind: daily` — a parse error — the moment it follows a key.
 */
function inline(value: unknown): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const pairs = Object.entries(value).map(([key, inner]) => `${key}: ${inline(inner)}`)
    return `{ ${pairs.join(', ')} }`
  }
  return stringifyYaml(value, { lineWidth: 0 }).trim()
}

/** How many entries a map may have before it is written under its key rather
 *  than beside it. `landing` has one and reads as a value; `hooks` has five and
 *  reads as a list of switches, which is also how the settings tab shows it. */
const FLOW_LIMIT = 2

/** A value as indented block YAML, or `undefined` when `inline` should be used
 *  instead. */
function block(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!Array.isArray(value) && Object.keys(value).length <= FLOW_LIMIT) return undefined
  return stringifyYaml(value, { lineWidth: 0 })
    .trimEnd()
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/** Wrapped to something a terminal and a narrow editor pane can both read.
 *  A `{ ... }` is one word: a landing target broken across two comment lines is
 *  a value you have to reassemble by eye before you can copy it. */
function wrap(text: string, width = 76): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.match(/\{[^}]*\}|\S+/g) ?? []) {
    if (line === '') line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      out.push(line)
      line = word
    }
  }
  if (line !== '') out.push(line)
  return out
}

/**
 * A settings file's text, written out in full every time.
 *
 * **The file lists every setting, whether or not this vault answers one.** It
 * used to carry only the questions the birth ritual asked, so `editorFont` and
 * `maxCommittedFileBytes` existed, worked, and appeared in no file anywhere —
 * you could only discover them in the settings tab. A setting this vault has
 * not answered is now a commented line, with its explanation and its legal
 * values above it.
 *
 * **That is also what lets a default stay a default.** D85's argument against
 * seeding `maxCommittedFileBytes` was that a number written into every vault at
 * birth is a default that can never be raised for the vaults that already have
 * one. A commented line is not a value: it is visible to a reader and invisible
 * to the resolver, so the setting can be documented in the file without being
 * frozen into it.
 *
 * **Generated, not merged** — the same reversal `writeThemeText` makes, for the
 * same reason and with the same cost. See its docstring: a comment inside a
 * nested block (`hooks`) cannot survive `doc.set`, and re-emitting is what
 * keeps the list complete when a setting is added to `VAULT_SETTINGS` later.
 * A key no setting describes is kept as written — the local file's `reminders`
 * watermark is machine state that has to survive, and deleting a line because
 * we do not recognise it would be worse than leaving it alone.
 */
export function writeSettingsText(values: Record<string, unknown>, target: SettingTarget): string {
  const committed = target === 'committed'
  const lines: string[] = [
    ...wrap(
      `Every setting this vault has. A COMMENTED line is not set: Holi\u2019s own default is in force, and a default can still improve later. Uncomment one to pin it for this vault.`,
    ).map((line) => `# ${line}`),
    '#',
    ...wrap(
      committed
        ? `This file is committed, so it travels with the vault and everyone who clones it gets these answers. Anything meant for this machine alone lives in ${SETTINGS_LOCAL_FILE} beside it.`
        : `This file is never committed. It is this machine\u2019s answer, and it overrides ${SETTINGS_FILE} key by key.`,
    ).map((line) => `# ${line}`),
  ]

  for (const setting of VAULT_SETTINGS) {
    if (setting.target !== target) continue
    lines.push('', `# ── ${setting.label}`)
    for (const line of wrap(setting.explanation, 72)) lines.push(`#   ${line}`)
    for (const hint of legalValues(setting.type)) {
      for (const line of wrap(hint, 72)) lines.push(`#   ${line}`)
    }
    const has = Object.prototype.hasOwnProperty.call(values, setting.key)
    const value = has ? values[setting.key] : setting.default
    const nested = block(value)
    // A commented line and a live one differ by the `# ` and nothing else, so
    // uncommenting is the whole edit — including for `hooks`, whose five
    // switches are each their own line.
    const mark = has ? '' : '# '
    if (nested === undefined) lines.push(`${mark}${setting.key}: ${inline(value)}`)
    else {
      lines.push(`${mark}${setting.key}:`)
      for (const line of nested.split('\n')) lines.push(`${mark}${line}`)
    }
  }

  const known = new Set(VAULT_SETTINGS.map((setting) => setting.key as string))
  const extra = Object.keys(values).filter((key) => !known.has(key))
  if (extra.length > 0) {
    lines.push('', '# ── Not settings Holi knows. Kept as you wrote them.')
    for (const key of extra) {
      const nested = block(values[key])
      if (nested === undefined) lines.push(`${key}: ${inline(values[key])}`)
      else {
        lines.push(`${key}:`)
        lines.push(nested)
      }
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * A fresh file holding the answers a vault is born with.
 *
 * What the seed writes. Everything else in `VAULT_SETTINGS` still appears,
 * commented — which is the difference between "every setting" and "every
 * question", now visible in the file rather than only in the settings tab.
 */
export function seedSettingsText(values: Record<string, unknown>, target: SettingTarget): string {
  return writeSettingsText(values, target)
}
