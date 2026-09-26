/**
 * Give an app that predates the manifest the `app.yaml` that registers it.
 *
 * Registration keys on `index.html` and `app.yaml` (see
 * `renderer/state/apps.ts`). Without this, an app with only an entry document
 * would silently vanish from the sidebar.
 *
 * Two deliberate refusals:
 *
 *   - **A directory with an invalid id is skipped, not fixed.** `My_App` cannot
 *     be an app id (it becomes a URL host; see `isValidAppId`), and renaming
 *     someone's directory would break every path they wrote.
 *   - **An existing manifest is never touched**, however empty. The user or
 *     their agent wrote it, and re-deriving `name` from the directory would
 *     undo a rename they made on purpose.
 *
 * The rule "manifest + entry document" is re-implemented here rather than
 * shared with the renderer's atoms: main cannot read an atom, and the snapshot
 * shape this needs does not exist yet at the point it runs.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { APPS_DIR, APP_MANIFEST_FILE, isValidAppId, vaultRelPath } from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'

const ENTRY_FILE = 'index.html'

/**
 * Write `app.yaml` for every app directory that has an entry document and no
 * manifest. Returns the ids migrated, sorted, for the caller to log.
 *
 * **Must run before the first snapshot the renderer sees** — beside
 * `ensureSeeded` in `vaults.open`, ahead of `host.open`. Run it after, and an
 * unmigrated app blinks out of the sidebar and back.
 */
export async function migrateAppManifests(root: string): Promise<string[]> {
  const appsDir = join(root, APPS_DIR)
  const entries = await readdir(appsDir, { withFileTypes: true }).catch(() => null)
  if (entries === null) return []

  const migrated: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !isValidAppId(entry.name)) continue

    const dir = join(appsDir, entry.name)
    const hasEntry = await exists(join(dir, ENTRY_FILE))
    if (!hasEntry) continue
    if (await exists(join(dir, APP_MANIFEST_FILE))) continue

    const rel = vaultRelPath(`${APPS_DIR}/${entry.name}/${APP_MANIFEST_FILE}`)
    await writeAtomic(root, rel, manifestFor(entry.name))
    migrated.push(entry.name)
  }
  return migrated
}

/** The directory name is already the identity, so `name` here only makes the
 *  label explicit — and gives the user somewhere obvious to change it. */
function manifestFor(id: string): string {
  const header = `# Written by Holi for an app that predates the manifest.`
  const note = "# Edit freely: the directory name is still the app's identity."
  return `${header}\n${note}\nname: ${id}\n`
}

async function exists(abs: string): Promise<boolean> {
  return (await stat(abs).catch(() => null))?.isFile() === true
}
