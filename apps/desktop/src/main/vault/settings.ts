/**
 * Reads a vault's settings off disk and resolves them.
 *
 * Two files, both optional: `.holi/settings.json` (committed, shared with
 * everyone who clones the vault) and `.holi/settings.local.json` (gitignored,
 * this machine only). The pure `resolveVaultSettings` (in `@holi/shared`) does
 * the merge + validation + defaulting; this module is only the disk half — a
 * missing or unreadable file degrades to `null`, never an error, so a vault with
 * no settings resolves to the defaults and the app behaves as it always did.
 *
 * Deliberately the same shape as `vault/theme.ts`, which does exactly this for
 * `.holi/theme.json`. Two files that differ only in which resolver they call
 * should not differ in anything else.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  TRANSFORM_NAMES,
  resolveVaultSettings,
  type ResolvedVaultSettings,
  type TransformName,
} from '@holi/shared'

/** The committed, shared settings — rides the normal watcher/snapshot path. */
export const SETTINGS_FILE = '.holi/settings.json'
/** The personal override — gitignored (`*.local.*`). Also where the reminder
 *  delivery watermark lives, which is why the resolver ignores keys it does not
 *  know rather than warning about them. */
export const SETTINGS_LOCAL_FILE = '.holi/settings.local.json'

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

/** Read a settings file as raw JSON, preserving every sibling key. Anything
 *  unusable reads as `{}` — a corrupt file is replaced rather than allowed to
 *  refuse the write forever. */
async function readRaw(abs: string): Promise<Record<string, unknown>> {
  const text = await readFile(abs, 'utf8').catch(() => null)
  if (text === null) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Merge one patch over one file's existing contents and write it atomically.
 *  `hooks` merges per transform; every other key replaces. */
async function mergeInto(abs: string, patch: Record<string, unknown>): Promise<void> {
  const existing = await readRaw(abs)
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
  // Atomic rename, copied from `reminders/delivered-log.ts`: a half-written
  // settings file is a vault that will not open the way it was asked to, and a
  // surviving `.tmp` in `.holi` would be committed and synced to everyone.
  const tmp = `${abs}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await rename(tmp, abs)
}

/**
 * Write answers into a vault's settings.
 *
 * **One merge-then-rename per file, never per key.** The onboarding step answers
 * four things at once, and four renames would be four chances to leave a vault
 * half-configured. Siblings this module knows nothing about survive because the
 * merge is over the file as it was read — `reminders`, written into the local
 * file by the delivery watermark, is the one that already exists.
 */
export async function writeVaultSettings(root: string, write: VaultSettingsWrite): Promise<void> {
  const jobs: Promise<void>[] = []
  if (write.committed !== undefined && Object.keys(write.committed).length > 0) {
    jobs.push(mergeInto(join(root, SETTINGS_FILE), write.committed))
  }
  if (write.local !== undefined && Object.keys(write.local).length > 0) {
    jobs.push(mergeInto(join(root, SETTINGS_LOCAL_FILE), write.local))
  }
  await Promise.all(jobs)
}
