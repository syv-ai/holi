/**
 * Reads a vault's settings off disk and resolves them (docs/features/settings.md).
 *
 * Four optional files: `.holi/settings/app.yaml` and `plugins.yaml` (committed)
 * and their `.local.yaml` twins (this machine only). `resolveVaultSettings` in
 * `@holi/shared` merges, validates and defaults; this module is only the disk
 * half, where a missing or unreadable file degrades to `null`, never an error.
 * Deliberately the same shape as `vault/theme.ts`.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isPluginsFileKey,
  parsePluginSettingsPatch,
  isTransformName,
  parseSettingsText,
  resolveVaultSettings,
  writePluginSettingsText,
  writeSettingsText,
  PLUGINS_FILE,
  PLUGINS_LOCAL_FILE,
  type SettingTarget,
  type ResolvedVaultSettings,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
} from '@holi/shared'
import { installedInfos } from '../plugin-host/installed'

/**
 * The committed settings and the personal override beside it. The local file
 * also holds the reminder delivery watermark, which is why the resolver ignores
 * keys it does not know rather than warning about them.
 */
export { SETTINGS_FILE, SETTINGS_LOCAL_FILE }

async function readOrNull(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, 'utf8')
  } catch {
    return null
  }
}

/** Resolve `<root>`'s settings from its two files. Never throws. */
export async function readVaultSettings(root: string): Promise<ResolvedVaultSettings> {
  const [app, appLocal, plugins, pluginsLocal] = await Promise.all([
    readOrNull(join(root, SETTINGS_FILE)),
    readOrNull(join(root, SETTINGS_LOCAL_FILE)),
    readOrNull(join(root, PLUGINS_FILE)),
    readOrNull(join(root, PLUGINS_LOCAL_FILE)),
  ])
  return resolveVaultSettings({ app, appLocal, plugins, pluginsLocal }, installedInfos())
}

/** A patch per file. Absent means "do not touch that file at all". */
export interface VaultSettingsWrite {
  committed?: Record<string, unknown>
  local?: Record<string, unknown>
}

/** Merge one patch over one file's existing contents and write it atomically.
 *  `hooks` merges per transform, `plugins` per plugin and a plugin's block
 *  per setting; every other key replaces. */
async function mergeInto(
  abs: string,
  patch: Record<string, unknown>,
  target: SettingTarget,
  file: 'app' | 'plugins',
): Promise<void> {
  const text = await readFile(abs, 'utf8').catch(() => null)
  // A file that is unusable reads as `{}` rather than refusing the write forever.
  const existing = parseSettingsText(text)
  // **The whole file, not the patch.** `writeSettingsText` regenerates the
  // document, so a key it is not handed disappears, including `reminders`,
  // machine state this module knows nothing about.
  const next: Record<string, unknown> = { ...existing, ...patch }

  // Per transform, so a patch answering one does not silently disable the rest.
  if (patch.hooks !== undefined) {
    const before = existing.hooks
    const merged: Record<string, boolean> = {}
    for (const source of [before, patch.hooks]) {
      if (typeof source !== 'object' || source === null || Array.isArray(source)) continue
      for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
        if (isTransformName(name) && typeof value === 'boolean') {
          merged[name] = value
        }
      }
    }
    next.hooks = merged
  }
  // Per plugin, for the same reason. Validated by `parseSettingsPatch`; what
  // the file already held is kept as written, for the read to judge.
  // A plugin's block per setting, for the same reason.
  if (file === 'plugins') {
    for (const key of Object.keys(patch)) {
      const before = existing[key]
      next[key] = {
        ...(typeof before === 'object' && before !== null && !Array.isArray(before) ? before : {}),
        ...(patch[key] as Record<string, unknown>),
      }
    }
  }

  await mkdir(dirname(abs), { recursive: true })
  // Atomic rename: a half-written settings file is a vault that will not open
  // the way it was asked to. `writeSettingsText` emits the whole document from
  // `VAULT_SETTINGS`, so a comment a person wrote in the file does not survive.
  const tmp = `${abs}.tmp`
  const written =
    file === 'app'
      ? writeSettingsText(next, target, installedInfos())
      : writePluginSettingsText(next, target, installedInfos())
  await writeFile(tmp, written, 'utf8')
  await rename(tmp, abs)
}

/**
 * Write answers into a vault's settings.
 *
 * **One merge-then-rename per file, never per key**, so a multi-answer write
 * cannot leave a vault half-configured. Keys this module does not know (the
 * local file's `reminders`) survive because the merge is over the values as read.
 */
export async function writeVaultSettings(root: string, write: VaultSettingsWrite): Promise<void> {
  const known = installedInfos()
  const files = {
    committed: { app: SETTINGS_FILE, plugins: PLUGINS_FILE },
    local: { app: SETTINGS_LOCAL_FILE, plugins: PLUGINS_LOCAL_FILE },
  } as const
  const jobs: Promise<void>[] = []
  for (const target of ['committed', 'local'] as const) {
    const patch = write[target]
    if (patch === undefined) continue
    // `plugins` and every plugin's block go to the plugins file; the rest to app.
    const split = { app: {} as Record<string, unknown>, plugins: {} as Record<string, unknown> }
    for (const [key, value] of Object.entries(patch)) {
      split[isPluginsFileKey(key, known) ? 'plugins' : 'app'][key] = value
    }
    for (const file of ['app', 'plugins'] as const) {
      if (Object.keys(split[file]).length === 0) continue
      jobs.push(mergeInto(join(root, files[target][file]), split[file], target, file))
    }
  }
  await Promise.all(jobs)
}

/**
 * Write some of one plugin's own settings into the file each one names
 * (`PluginSetting.target`). Validated like any settings write; the warnings
 * say what was refused.
 */
export async function writePluginSettings(
  root: string,
  pluginId: string,
  values: Record<string, unknown>,
): Promise<string[]> {
  const known = installedInfos()
  const info = known.find((p) => p.id === pluginId)
  if (info === undefined) return [`no plugin ${pluginId}`]
  const write: VaultSettingsWrite = {}
  const warnings: string[] = []
  for (const [key, value] of Object.entries(values)) {
    const setting = (info.settings ?? []).find((s) => s.key === key)
    if (setting === undefined) {
      warnings.push(`refused "${pluginId}.${key}": ${info.label} has no such setting`)
      continue
    }
    const { patch, warnings: refused } = parsePluginSettingsPatch(
      JSON.stringify({ [pluginId]: { [key]: value } }),
      known,
    )
    warnings.push(...refused)
    const block = (patch[pluginId] ?? {}) as Record<string, unknown>
    if (!(key in block)) continue
    const target = (write[setting.target] ??= {})
    target[pluginId] = {
      ...((target[pluginId] as Record<string, unknown>) ?? {}),
      [key]: block[key],
    }
  }
  await writeVaultSettings(root, write)
  return warnings
}
