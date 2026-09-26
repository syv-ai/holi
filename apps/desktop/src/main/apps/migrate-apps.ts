/**
 * Move the apps a vault kept in `.holi/apps/<id>/` to `<id>.app/` at its root
 * (D107), where the tree shows them.
 *
 * **One `rename` per app, not a file-by-file move.** A file walk would drop
 * empty directories, and one rename is atomic on the same filesystem: the app
 * is at the old path or the new one, never half at each.
 *
 * The `[[link]]` rewrite is a second pass, **after** every directory has moved:
 * a crash between the two leaves apps moved with stale links, which show as
 * tombstones, rather than live links pointing at bytes that are gone. Same
 * no-transaction contract as `moveNotes`.
 *
 * Nothing here commits. It runs before `host.open`, like the other open-time
 * migrations, and the moves reach git through the ordinary autosave.
 */
import { readFile, readdir, rename, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_SUFFIX, isAppBundlePath, rewriteWikiLinksMulti, vaultRelPath } from '@holi/shared'
import { absPathFor, listFiles, writeAtomic } from '../vault/vault-files'

/** A literal, not a constant: the place apps used to be, which nothing else
 *  names any more. */
const LEGACY_APPS_DIR = '.holi/apps'

export interface AppMigration {
  /** `from → to`, vault-relative directories, sorted by `from`. */
  moved: { from: string; to: string }[]
  /** Apps left where they were because their destination already exists. */
  skipped: string[]
}

/** Idempotent: a vault with no `.holi/apps` is `{ moved: [], skipped: [] }`. */
export async function migrateApps(root: string): Promise<AppMigration> {
  const legacy = join(root, LEGACY_APPS_DIR)
  const entries = await readdir(legacy, { withFileTypes: true }).catch(() => null)
  if (entries === null) return { moved: [], skipped: [] }

  const moved: { from: string; to: string }[] = []
  const skipped: string[] = []
  const links = new Map<string, string>()
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const from = `${LEGACY_APPS_DIR}/${entry.name}`
    const to = `${entry.name}${APP_SUFFIX}`
    if (!isAppBundlePath(to) || (await exists(join(root, to)))) {
      skipped.push(from)
      continue
    }
    // The link map has to be built while the files are still at the old paths.
    for (const path of await listFiles(root, from)) {
      links.set(path, `${to}${path.slice(from.length)}`)
    }
    await rename(join(root, from), join(root, to))
    moved.push({ from, to })
  }

  // Only once it is empty: a skipped app, or a stray file, keeps it.
  await rmdir(legacy).catch(() => {})

  if (links.size > 0) {
    for (const path of await listFiles(root)) {
      if (!path.endsWith('.md')) continue
      const rel = vaultRelPath(path)
      const text = await readFile(absPathFor(root, rel), 'utf8')
      const { text: next, count } = rewriteWikiLinksMulti(text, links)
      if (count > 0) await writeAtomic(root, rel, next)
    }
  }
  return { moved, skipped }
}

async function exists(abs: string): Promise<boolean> {
  return (await stat(abs).catch(() => null)) !== null
}
