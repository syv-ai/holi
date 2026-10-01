/**
 * Reading and writing a settings file that explains itself.
 *
 * Every setting's label, explanation and legal values go into the file as
 * comments, generated from the same `VAULT_SETTINGS` schema the settings tab
 * renders, so a person or the agent editing the file by hand sees what each key
 * means and the two cannot disagree.
 *
 * YAML rather than JSONC or a `$schema` key because it is already the vault's
 * idiom for anything a person writes (frontmatter, `app.yaml`).
 *
 * **A write regenerates the whole document** (`writeSettingsText`), so a
 * comment a person wrote inside the file does not survive a write. Values do:
 * every known key is re-emitted, and an unknown key is kept as written.
 *
 * YAML is a superset of JSON, so a `.json` settings file also parses here.
 */
import { parseDocument, stringify as stringifyYaml } from 'yaml'
import type { PluginInfo } from './plugins'
import {
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  VAULT_SETTINGS,
  type SettingTarget,
  type SettingType,
  type VaultSetting,
} from './vault-settings'

/**
 * Parse a settings file into a plain object.
 *
 * Anything that is not a mapping reads as "no settings": a half-written file
 * must not stop a vault opening.
 */
export function parseSettingsText(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === '') return {}
  try {
    const doc = parseDocument(text)
    // **Errors as well as shape.** `parseDocument` does not throw on a broken
    // file; it records the error and still hands back a map, so `{ not json`
    // would read as the key `not json`.
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
 * **The options, not the type name**: "One of: mono, sans, serif", not "an
 * EditorFont". Derived from `SettingType` so a control, a validator and this
 * line cannot offer three different answers.
 */
function legalValues(type: SettingType): string[] {
  if (type.kind === 'boolean') return ['One of: true, false']
  if (type.kind === 'flags') {
    return ['Each one is true or false. Naming one says nothing about the others.']
  }
  if (type.kind === 'plugins') {
    return ['Each plugin is true or false. A commented one runs as its default says.']
  }
  const shown = type.options.map((o) => `${inline(o.value)} (${o.label})`).join(', ')
  if (type.kind === 'number') {
    // The options are what the PANE offers; the validator takes any positive
    // number, so this list must not read as the whole legal range.
    return [`Any positive number of bytes. What the pane offers: ${shown}`]
  }
  if (type.kind === 'enum') return [`One of: ${shown}`]
  // `home`: the options, and any app or file the vault holds.
  return [`One of: ${shown}`, 'Or any app or file in the vault, by its path.']
}

/**
 * A value small enough to sit on its key's line: `mono`, `{ kind: daily }`.
 *
 * **A map has to be written in flow style here, not block.** `stringify` gives
 * a one-entry map back as `kind: daily`, which is correct YAML on its own and
 * becomes `key: kind: daily`, a parse error, the moment it follows a key.
 */
function inline(value: unknown): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const pairs = Object.entries(value).map(([key, inner]) => `${key}: ${inline(inner)}`)
    return `{ ${pairs.join(', ')} }`
  }
  return stringifyYaml(value, { lineWidth: 0 }).trim()
}

/** How many entries a map may have before it is written under its key rather
 *  than beside it. A map of one or two reads as a value; `hooks` has five and
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
 *  A `{ ... }` is one word, so a small map is never split across lines. */
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
 * **The file lists every setting, whether or not this vault answers one.** A
 * setting this vault has not answered is a commented line, with its explanation
 * and legal values above it, so it is discoverable without the settings tab.
 *
 * **That is also what lets a default stay a default**: a commented line
 * is visible to a reader and invisible to the resolver, so a default can still
 * be raised later for vaults that never pinned it.
 *
 * **Generated, not merged**, like `writeThemeText`: re-emitting keeps the list
 * complete when a setting is added to `VAULT_SETTINGS`, and the cost is that
 * hand-written comments are lost. A key no setting describes is kept as written:
 * the local file's `reminders` watermark is machine state that has to survive.
 */
export function writeSettingsText(
  values: Record<string, unknown>,
  target: SettingTarget,
  /** The plugins this build has, so the committed file lists each one. */
  known: readonly PluginInfo[],
): string {
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
    if (setting.type.kind === 'plugins') {
      lines.push(...pluginLines(setting, values, target, known))
      continue
    }
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
    // uncommenting is the whole edit, including for a nested block like `hooks`.
    const mark = has ? '' : '# '
    if (nested === undefined) lines.push(`${mark}${setting.key}: ${inline(value)}`)
    else {
      lines.push(`${mark}${setting.key}:`)
      for (const line of nested.split('\n')) lines.push(`${mark}${line}`)
    }
  }

  const settingKeys = new Set(VAULT_SETTINGS.map((setting) => setting.key as string))
  const extra = Object.keys(values).filter((key) => !settingKeys.has(key))
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
 * The `plugins` block. The committed file lists every plugin the build has,
 * an unanswered one commented with its default, like any other setting. The
 * local file can only turn a plugin off, so it shows the block only when it
 * answers one.
 */
function pluginLines(
  setting: VaultSetting,
  values: Record<string, unknown>,
  target: SettingTarget,
  known: readonly PluginInfo[],
): string[] {
  const has = Object.prototype.hasOwnProperty.call(values, setting.key)
  const value = values[setting.key]
  const answered =
    has && typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  const out: string[] = ['', `# ── ${setting.label}`]

  if (target === 'local') {
    if (!has) return []
    out.push(
      ...wrap(
        `false turns a plugin off on this machine alone. Only ${SETTINGS_FILE} turns one on.`,
        72,
      ).map((line) => `#   ${line}`),
    )
  } else {
    for (const line of wrap(setting.explanation, 72)) out.push(`#   ${line}`)
    for (const hint of legalValues(setting.type)) {
      for (const line of wrap(hint, 72)) out.push(`#   ${line}`)
    }
  }

  // Answered but not a map: kept as written, for the read to complain about.
  if (has && answered === null) {
    out.push(`${setting.key}: ${inline(value)}`)
    return out
  }
  const live = answered !== null && Object.keys(answered).length > 0
  // A live block's unanswered ids are commented inside it; a block with
  // nothing answered is commented whole. Either way uncommenting is the edit.
  const unset = (id: string, on: boolean) =>
    live ? `  # ${id}: ${inline(on)}` : `#   ${id}: ${inline(on)}`
  const entries: string[] = []
  // The build's plugins in its order, then any id it does not have, kept.
  for (const plugin of target === 'committed' ? known : []) {
    if (answered === null || !(plugin.id in answered))
      entries.push(unset(plugin.id, plugin.default))
    else entries.push(`  ${plugin.id}: ${inline(answered[plugin.id])}`)
  }
  for (const [id, on] of Object.entries(answered ?? {})) {
    if (target === 'local' || !known.some((p) => p.id === id))
      entries.push(`  ${id}: ${inline(on)}`)
  }
  if (entries.length === 0) out.push(`# ${setting.key}: {}`)
  else out.push(`${live ? '' : '# '}${setting.key}:`, ...entries)
  return out
}

/**
 * A fresh file holding the answers a vault is born with.
 *
 * What the seed writes. Everything else in `VAULT_SETTINGS` still appears,
 * commented.
 */
export function seedSettingsText(
  values: Record<string, unknown>,
  target: SettingTarget,
  known: readonly PluginInfo[],
): string {
  return writeSettingsText(values, target, known)
}
