/**
 * Reads a vault's settings off disk and resolves them (docs/features/settings.md).
 *
 * Two optional files: `.holi/settings/app.yaml` (committed) and
 * `.holi/settings/app.local.yaml` (this machine only). `resolveVaultSettings` in
 * `@holi/shared` merges, validates and defaults; this module is only the disk
 * half, where a missing or unreadable file degrades to `null`, never an error.
 * Deliberately the same shape as `vault/theme.ts`.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  TRANSFORM_NAMES,
  parseSettingsText,
  resolveVaultSettings,
  writeSettingsText,
  type SettingTarget,
  type ResolvedVaultSettings,
  type TransformName,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
} from '@holi/shared'

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
  const [committed, local] = await Promise.all([
    readOrNull(join(root, SETTINGS_FILE)),
    readOrNull(join(root, SETTINGS_LOCAL_FILE)),
  ])
  return resolveVaultSettings(committed, local)
}

/** A patch per file. Absent means "do not touch that file at all". */
export interface VaultSettingsWrite {
  committed?: Record<string, unknown>
  local?: Record<string, unknown>
}

/** Merge one patch over one file's existing contents and write it atomically.
 *  `hooks` merges per transform; every other key replaces. */
async function mergeInto(
  abs: string,
  patch: Record<string, unknown>,
  target: SettingTarget,
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
    const merged: Partial<Record<TransformName, boolean>> = {}
    for (const source of [before, patch.hooks]) {
      if (typeof source !== 'object' || source === null || Array.isArray(source)) continue
      for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
        if (TRANSFORM_NAMES.includes(name as TransformName) && typeof value === 'boolean') {
          merged[name as TransformName] = value
        }
      }
    }
    next.hooks = merged
  }

  await mkdir(dirname(abs), { recursive: true })
  // Atomic rename: a half-written settings file is a vault that will not open
  // the way it was asked to. `writeSettingsText` emits the whole document from
  // `VAULT_SETTINGS`, so a comment a person wrote in the file does not survive.
  const tmp = `${abs}.tmp`
  await writeFile(tmp, writeSettingsText(next, target), 'utf8')
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
  const jobs: Promise<void>[] = []
  if (write.committed !== undefined && Object.keys(write.committed).length > 0) {
    jobs.push(mergeInto(join(root, SETTINGS_FILE), write.committed, 'committed'))
  }
  if (write.local !== undefined && Object.keys(write.local).length > 0) {
    jobs.push(mergeInto(join(root, SETTINGS_LOCAL_FILE), write.local, 'local'))
  }
  await Promise.all(jobs)
}
