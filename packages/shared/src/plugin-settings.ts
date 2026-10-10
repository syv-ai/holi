/**
 * Everything a vault says about its plugins: which run, and each plugin's own
 * settings. See docs/features/settings.md.
 *
 * Two files beside `app.yaml`: `.holi/settings/plugins.yaml` (committed) and
 * `.holi/settings/plugins.local.yaml` (this machine only). The `plugins` block
 * says which plugins run; the committed file declares them and the local file
 * can only turn one off. Every other top-level key is a plugin's id, holding
 * the settings that plugin declares (`PluginInfo.settings`), read per key with
 * the local file winning, like `app.yaml`.
 *
 * A trust boundary like `vault-settings.ts`: every value is checked against
 * the setting that declares it and a fresh value is built, and nothing here
 * throws. A block for a plugin this build does not have is kept in the file
 * and ignored.
 *
 * Pure and browser-safe.
 */
import { parse as parseYaml } from 'yaml'
import { isPluginId, type PluginInfo, type PluginSettings } from './plugins'
import type { SettingTarget, VaultSettingOption } from './vault-settings'

export const PLUGINS_FILE = '.holi/settings/plugins.yaml'
export const PLUGINS_LOCAL_FILE = '.holi/settings/plugins.local.yaml'

/** What a plugin setting's value is, which is also how its row edits it. */
export type PluginSettingType =
  | { kind: 'boolean' }
  /** One of these values, and only these. */
  | { kind: 'enum'; options: readonly VaultSettingOption[] }
  /** Any finite number. */
  | { kind: 'number' }
  | { kind: 'text' }
  /** A list of text, in order. */
  | { kind: 'list' }
  /** On or off per name, for names the plugin learns at run time
   *  (calendars, accounts). */
  | { kind: 'switches' }

/** One setting a plugin declares, beside its info. */
export interface PluginSetting {
  /** camelCase, unique within the plugin. Written under the plugin's id. */
  key: string
  label: string
  explanation: string
  type: PluginSettingType
  /** The value when no file answers it. Must pass its own type. */
  default: unknown
  target: SettingTarget
}

/** Resolved values, by plugin id then setting key. */
export type PluginValues = Record<string, Record<string, unknown>>

export interface ResolvedPluginSettings {
  plugins: PluginSettings
  /** Every known plugin's declared settings, answered or defaulted. */
  values: PluginValues
  warnings: string[]
}

const SETTING_KEY = /^[a-z][A-Za-z0-9]*$/

/** Is `key` something a plugin setting could be called? */
export const isPluginSettingKey = (key: string): boolean => SETTING_KEY.test(key)

function parseFile(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === '') return {}
  try {
    const parsed: unknown = parseYaml(text)
    return isMap(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one untrusted value for one plugin setting: the check the reader, the
 * writer and the catalogue share.
 */
export function readPluginValue(
  type: PluginSettingType,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; expected: string } {
  switch (type.kind) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, expected: 'true or false' }
    case 'enum':
      return type.options.some((o) => o.value === value)
        ? { ok: true, value }
        : { ok: false, expected: `one of ${type.options.map((o) => String(o.value)).join(', ')}` }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, expected: 'a number' }
    case 'text':
      return typeof value === 'string' ? { ok: true, value } : { ok: false, expected: 'text' }
    case 'list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? { ok: true, value: [...value] }
        : { ok: false, expected: 'a list of text' }
    case 'switches':
      return isMap(value) && Object.values(value).every((v) => typeof v === 'boolean')
        ? { ok: true, value: { ...value } }
        : { ok: false, expected: 'a name to true or false, for each name' }
  }
}

/** A fresh copy of a default, so a caller mutating it cannot change the next read. */
function fresh(value: unknown): unknown {
  if (Array.isArray(value)) return [...value]
  return isMap(value) ? { ...value } : value
}

/**
 * One file's `plugins` block as a map of plugin id to on or off, dropping
 * what is not one, with a warning per drop. Null when the file says nothing.
 */
function pluginBlock(
  file: Record<string, unknown>,
  warnings: string[],
  verb: 'dropped' | 'refused',
): Record<string, boolean> | null {
  if (!('plugins' in file)) return null
  const block = file.plugins
  if (!isMap(block)) {
    warnings.push(`${verb} "plugins": expected an object, got ${JSON.stringify(block)}`)
    return null
  }
  const out: Record<string, boolean> = {}
  for (const [id, on] of Object.entries(block)) {
    if (!isPluginId(id)) warnings.push(`${verb} "plugins.${id}": not a plugin id`)
    else if (typeof on !== 'boolean') {
      warnings.push(`${verb} "plugins.${id}": expected true or false, got ${JSON.stringify(on)}`)
    } else out[id] = on
  }
  return out
}

/**
 * Resolve the two plugins files. Either text may be `null` (file absent).
 * Never throws; every known plugin's every setting is answered.
 */
export function resolvePluginSettings(
  committedText: string | null,
  localText: string | null,
  known: readonly PluginInfo[],
): ResolvedPluginSettings {
  const committed = parseFile(committedText)
  const local = parseFile(localText)
  const warnings: string[] = []

  // The committed file's answers are the vault's; the local file contributes
  // only its `false`s, since only the vault turns a plugin on.
  const vault = pluginBlock(committed, warnings, 'dropped') ?? {}
  const localOff: string[] = []
  for (const [id, on] of Object.entries(pluginBlock(local, warnings, 'dropped') ?? {})) {
    if (on) {
      warnings.push(
        `dropped "plugins.${id}" in ${PLUGINS_LOCAL_FILE}: this machine can only turn a plugin off`,
      )
    } else localOff.push(id)
  }

  const values: PluginValues = {}
  for (const info of known) {
    const out: Record<string, unknown> = {}
    const blocks = [committed[info.id], local[info.id]].map((block) => {
      if (block === undefined) return {}
      if (isMap(block)) return block
      warnings.push(`dropped "${info.id}": expected an object, got ${JSON.stringify(block)}`)
      return {}
    })
    for (const setting of info.settings ?? []) {
      // The last file that mentions the key answers it.
      let raw: unknown
      for (const block of blocks) if (setting.key in block) raw = block[setting.key]
      if (raw === undefined) {
        out[setting.key] = fresh(setting.default)
        continue
      }
      const read = readPluginValue(setting.type, raw)
      if (read.ok) out[setting.key] = read.value
      else {
        warnings.push(
          `dropped "${info.id}.${setting.key}": expected ${read.expected}, got ${JSON.stringify(raw)}`,
        )
        out[setting.key] = fresh(setting.default)
      }
    }
    values[info.id] = out
  }
  return { plugins: { vault, localOff }, values, warnings }
}

/**
 * Read an untrusted object as a patch for the plugins files: the `plugins`
 * block and each known plugin's declared settings, each validated, and nothing
 * else. Like `parseSettingsPatch`, a write cannot create a key Holi does not
 * own; other keys are left for that one.
 */
export function parsePluginSettingsPatch(
  json: string | null,
  known: readonly PluginInfo[],
): { patch: Record<string, unknown>; warnings: string[] } {
  const raw = parseFile(json)
  const patch: Record<string, unknown> = {}
  const warnings: string[] = []

  const plugins = pluginBlock(raw, warnings, 'refused')
  if (plugins !== null && Object.keys(plugins).length > 0) patch.plugins = plugins

  for (const info of known) {
    if (!(info.id in raw)) continue
    const block = raw[info.id]
    if (!isMap(block)) {
      warnings.push(`refused "${info.id}": ${JSON.stringify(block)}`)
      continue
    }
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(block)) {
      const setting = (info.settings ?? []).find((s) => s.key === key)
      if (setting === undefined) {
        warnings.push(`refused "${info.id}.${key}": ${info.label} has no such setting`)
        continue
      }
      const read = readPluginValue(setting.type, value)
      if (read.ok) out[key] = read.value
      else warnings.push(`refused "${info.id}.${key}": ${JSON.stringify(value)}`)
    }
    if (Object.keys(out).length > 0) patch[info.id] = out
  }
  return { patch, warnings }
}

/** Does a patch key belong in the plugins files rather than `app.yaml`? */
export function isPluginsFileKey(key: string, known: readonly PluginInfo[]): boolean {
  return key === 'plugins' || known.some((p) => p.id === key)
}

/**
 * A plugin's setting as resolved, or its declared default when the values do
 * not hold it (settings not read yet). The typed read a plugin wraps once.
 */
export function pluginSettingValue(values: PluginValues, info: PluginInfo, key: string): unknown {
  const setting = (info.settings ?? []).find((s) => s.key === key)
  if (setting === undefined) throw new Error(`${info.id} declares no setting ${key}`)
  const value = values[info.id]?.[key]
  return value === undefined ? fresh(setting.default) : value
}

/** The problems with one plugin's declared settings, for the catalogue check. */
export function pluginSettingsProblems(info: PluginInfo): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const setting of info.settings ?? []) {
    if (!isPluginSettingKey(setting.key)) {
      problems.push(`plugin ${info.id} setting ${setting.key} is not camelCase`)
    }
    if (seen.has(setting.key)) problems.push(`plugin ${info.id} declares ${setting.key} twice`)
    seen.add(setting.key)
    if (!readPluginValue(setting.type, setting.default).ok) {
      problems.push(`plugin ${info.id} setting ${setting.key} has a default its type refuses`)
    }
  }
  return problems
}

/**
 * The plugin list a build hands each process, checked once for what could
 * never work: a bad or repeated id, a requirement this build does not have,
 * plugins requiring each other in a circle, or a setting declared wrong. Main and the renderer both
 * call it at boot, so a broken list fails in either.
 */
export function checkPluginCatalogue(known: readonly PluginInfo[]): void {
  const byId = new Map<string, PluginInfo>()
  for (const p of known) {
    if (!isPluginId(p.id)) throw new Error(`plugin id ${p.id} is not kebab-case`)
    if (byId.has(p.id)) throw new Error(`plugin ${p.id} is installed twice`)
    byId.set(p.id, p)
  }
  for (const p of known) {
    const missing = (p.requires ?? []).filter((id) => !byId.has(id))
    if (missing.length > 0) throw new Error(`plugin ${p.id} requires ${missing.join(', ')}`)
  }
  const done = new Set<string>()
  const visit = (id: string, path: string[]): void => {
    if (done.has(id)) return
    if (path.includes(id))
      throw new Error(`plugins require each other: ${[...path, id].join(' > ')}`)
    for (const next of byId.get(id)?.requires ?? []) visit(next, [...path, id])
    done.add(id)
  }
  for (const p of known) visit(p.id, [])
  const problems = known.flatMap(pluginSettingsProblems)
  if (problems.length > 0) throw new Error(problems.join('; '))
}
