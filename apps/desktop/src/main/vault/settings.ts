/**
 * Reads a vault's settings off disk and resolves them.
 *
 * Two files, both optional: `.holi/settings/app.yaml` (committed, shared with
 * everyone who clones the vault) and `.holi/settings/app.local.yaml` (gitignored,
 * this machine only). The pure `resolveVaultSettings` (in `@holi/shared`) does
 * the merge + validation + defaulting; this module is only the disk half — a
 * missing or unreadable file degrades to `null`, never an error, so a vault with
 * no settings resolves to the defaults and the app behaves as it always did.
 *
 * Deliberately the same shape as `vault/theme.ts`, which does exactly this for
 * `.holi/settings/theme.yaml`. Two files that differ only in which resolver they
 * call should not differ in anything else.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  TRANSFORM_NAMES,
  parseSettingsText,
  resolveVaultSettings,
  writeSettingsText,
  type ResolvedVaultSettings,
  type TransformName,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
} from '@holi/shared'

/**
 * The committed, shared settings and the personal override beside it.
 *
 * **Re-exported, not redeclared.** These were a second copy of the literal, and
 * a path declared twice is a path that gets moved once. The local file is also
 * where the reminder delivery watermark lives, which is why the resolver
 * ignores keys it does not know rather than warning about them.
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
async function mergeInto(abs: string, patch: Record<string, unknown>): Promise<void> {
  const text = await readFile(abs, 'utf8').catch(() => null)
  // Read twice, for two different things: the VALUES, to merge `hooks` against,
  // and the TEXT, so the write can keep the document. A file that is unusable
  // reads as `{}` rather than refusing the write forever.
  const existing = parseSettingsText(text)
  const next: Record<string, unknown> = { ...patch }

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
  //
  // **The document, not the values.** `writeSettingsText` merges into the file
  // as it was written, so the explanations above each key survive the write —
  // and so does anything the user or the agent added. Stringifying `next` would
  // delete all of it, once, permanently.
  const tmp = `${abs}.tmp`
  await writeFile(tmp, writeSettingsText(text, next), 'utf8')
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
