/**
 * Each app's preview: a small picture of it, taken from its frame the last
 * time it ran in a tab, for its card on the Apps page
 * (docs/features/vault-apps.md, Previews).
 *
 * Kept on this machine, never in the vault: one JPEG and one JSON beside it
 * per app under `userData/app-previews/`, named by a hash of the vault's
 * remote and the bundle's path, so no path is a filename and two vaults
 * never share one. The JSON says which app the picture is of and the
 * bundle's stamp when it was taken: the newest mtime of its files, records
 * (`data/`) and the log aside, as the approval's hash leaves them out, and
 * the manifest too, which says what the app is (its description, whether it
 * is archived) rather than how it looks. A
 * preview is served only while that stamp still holds, so an edit to the
 * app's code makes it stale at once and the card shows the icon until the
 * app runs again.
 *
 * No `electron` import: the picture arrives as JPEG bytes, so this loads
 * under plain Node in the tests.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_LOG_FILE, DATA_DIR, vaultRelPath } from '@holi/shared'
import { APP_MANIFEST_FILE } from '../shared/manifest'

/** What a stored preview says about itself. */
interface PreviewMeta {
  remote: string
  bundle: string
  /** The bundle's stamp when it was taken (`bundleStamp`). */
  stamp: number
}

/** The file stem for one app's preview: neither the remote nor the path
 *  reaches the filesystem as a name.
 * @public exported for its test
 */
export function previewKey(remote: string, bundle: string): string {
  return createHash('sha256').update(`${remote}\0${bundle}`).digest('hex').slice(0, 32)
}

/**
 * The newest mtime (ms) among the bundle's files, its records, its log and
 * its manifest aside: what changes when the app's look does. Links are not followed, as
 * nothing the protocol serves goes through one. 0 for a bundle with no files.
 * @public exported for its test
 */
export async function bundleStamp(root: string, bundle: string): Promise<number> {
  const base = join(root, vaultRelPath(bundle))
  let newest = 0
  async function walk(dir: string, rel: string): Promise<void> {
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      const sub = rel === '' ? name : `${rel}/${name}`
      if (sub === DATA_DIR || sub === APP_LOG_FILE || sub === APP_MANIFEST_FILE) continue
      const info = await lstat(join(dir, name)).catch(() => null)
      if (info === null || info.isSymbolicLink()) continue
      if (info.isDirectory()) await walk(join(dir, name), sub)
      else if (info.isFile()) newest = Math.max(newest, info.mtimeMs)
    }
  }
  await walk(base, '')
  return newest
}

export interface AppPreviews {
  /** The app's preview as a `data:` URL, or null when there is none or it
   *  is stale. */
  read(remote: string, root: string, bundle: string): Promise<string | null>
  /** Keep `jpeg` as the app's preview, stamped with the bundle as it is now. */
  save(remote: string, root: string, bundle: string, jpeg: Buffer): Promise<void>
  /** Let the app's preview go. */
  forget(remote: string, bundle: string): Promise<void>
}

export function createAppPreviews(dir: string): AppPreviews {
  const paths = (remote: string, bundle: string) => {
    const key = previewKey(remote, bundle)
    return { image: join(dir, `${key}.jpg`), meta: join(dir, `${key}.json`) }
  }

  return {
    async read(remote, root, bundle) {
      const at = paths(remote, bundle)
      const meta = await readFile(at.meta, 'utf8')
        .then((text) => JSON.parse(text) as Partial<PreviewMeta>)
        .catch(() => null)
      // The names are a hash: the file must also say it is this app's.
      if (meta === null || meta.remote !== remote || meta.bundle !== bundle) return null
      if (meta.stamp !== (await bundleStamp(root, bundle))) return null
      const image = await readFile(at.image).catch(() => null)
      if (image === null || image.length === 0) return null
      return `data:image/jpeg;base64,${image.toString('base64')}`
    },

    async save(remote, root, bundle, jpeg) {
      const at = paths(remote, bundle)
      const meta: PreviewMeta = { remote, bundle, stamp: await bundleStamp(root, bundle) }
      await mkdir(dir, { recursive: true })
      await writeFile(at.image, jpeg)
      await writeFile(at.meta, JSON.stringify(meta))
    },

    async forget(remote, bundle) {
      const at = paths(remote, bundle)
      await Promise.all([rm(at.image, { force: true }), rm(at.meta, { force: true })])
    },
  }
}
