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
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { APP_LOG_FILE, DATA_DIR, vaultRelPath } from '@holi/shared'
import { APP_MANIFEST_FILE } from '../shared/manifest'

/** What a stored preview says about itself. */
interface PreviewMeta {
  remote: string
  bundle: string
  /** The bundle's stamp when it was taken (`bundleStamp`). */
  stamp: number
  image?: string
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
  /** Capture the invalidation generation before doing asynchronous work. */
  revision(remote: string, bundle: string): number
  /** Keep `jpeg` as the app's preview, stamped with the bundle as it is now. */
  save(
    remote: string,
    root: string,
    bundle: string,
    jpeg: Buffer,
    current?: () => boolean,
    revision?: number,
    expectedStamp?: number,
  ): Promise<boolean>
  /** Let the app's preview go. */
  forget(remote: string, bundle: string): Promise<void>
}

const operations = new Map<string, Promise<unknown>>()
const revisions = new Map<string, number>()

/** Serialize preview state across plugin activations sharing the same storage. */
function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  operations.set(key, next)
  void next
    .finally(() => {
      if (operations.get(key) === next) operations.delete(key)
    })
    .catch(() => {})
  return next
}

export function createAppPreviews(dir: string): AppPreviews {
  const storage = resolve(dir)
  const paths = (remote: string, bundle: string) => {
    const key = previewKey(remote, bundle)
    return { image: join(storage, `${key}.jpg`), meta: join(storage, `${key}.json`) }
  }
  const operationKey = (remote: string, bundle: string) => `${storage}\0${remote}\0${bundle}`

  return {
    revision(remote, bundle) {
      return revisions.get(operationKey(remote, bundle)) ?? 0
    },

    async read(remote, root, bundle) {
      const at = paths(remote, bundle)
      return serialize(operationKey(remote, bundle), async () => {
        const meta = await readFile(at.meta, 'utf8')
          .then((text) => JSON.parse(text) as Partial<PreviewMeta>)
          .catch(() => null)
        // The names are a hash: the file must also say it is this app's.
        if (meta === null || meta.remote !== remote || meta.bundle !== bundle) return null
        if (meta.stamp !== (await bundleStamp(root, bundle))) return null
        const imageName =
          typeof meta.image === 'string' ? meta.image : `${previewKey(remote, bundle)}.jpg`
        if (basename(imageName) !== imageName) return null
        const image = await readFile(join(storage, imageName)).catch(() => null)
        if (image === null || image.length === 0) return null
        return `data:image/jpeg;base64,${image.toString('base64')}`
      })
    },

    async save(remote, root, bundle, jpeg, current = () => true, revision, expectedStamp) {
      const at = paths(remote, bundle)
      const key = operationKey(remote, bundle)
      // Capture at invocation, before waiting behind another publication.
      // Callers that captured before async work pass the revision explicitly.
      const expectedRevision = revision ?? revisions.get(key) ?? 0
      const stamp =
        expectedStamp === undefined ? bundleStamp(root, bundle) : Promise.resolve(expectedStamp)
      return serialize(key, async () => {
        const captureStamp = await stamp
        if (
          !current() ||
          (revisions.get(key) ?? 0) !== expectedRevision ||
          captureStamp !== (await bundleStamp(root, bundle))
        )
          return false
        await mkdir(storage, { recursive: true })
        const previous = await readFile(at.meta, 'utf8')
          .then((text) => JSON.parse(text) as Partial<PreviewMeta>)
          .catch(() => null)
        const imageName = `${previewKey(remote, bundle)}.${randomUUID()}.jpg`
        const stagedImage = join(storage, `${imageName}.tmp`)
        const stagedMeta = `${at.meta}.${randomUUID()}.tmp`
        let metadataPublished = false
        try {
          await writeFile(stagedImage, jpeg)
          const afterPreparation = await bundleStamp(root, bundle)
          if (
            !current() ||
            (revisions.get(key) ?? 0) !== expectedRevision ||
            captureStamp !== afterPreparation
          )
            return false
          await rename(stagedImage, join(storage, imageName))
          const meta: PreviewMeta = { remote, bundle, stamp: captureStamp, image: imageName }
          await writeFile(stagedMeta, JSON.stringify(meta))
          if (
            !current() ||
            (revisions.get(key) ?? 0) !== expectedRevision ||
            captureStamp !== (await bundleStamp(root, bundle))
          )
            return false
          await rename(stagedMeta, at.meta)
          metadataPublished = true
          if (
            !current() ||
            (revisions.get(key) ?? 0) !== expectedRevision ||
            captureStamp !== (await bundleStamp(root, bundle))
          ) {
            const published = await readFile(at.meta, 'utf8').catch(() => null)
            if (published === JSON.stringify(meta)) await rm(at.meta, { force: true })
            await rm(join(storage, imageName), { force: true })
            return false
          }
          const oldImage = previous?.image
          if (
            typeof oldImage === 'string' &&
            basename(oldImage) === oldImage &&
            oldImage !== imageName
          ) {
            await rm(join(storage, oldImage), { force: true })
          } else if (!oldImage) {
            await rm(at.image, { force: true })
          }
          return true
        } finally {
          await Promise.all([
            rm(stagedImage, { force: true }),
            rm(stagedMeta, { force: true }),
            ...(metadataPublished ? [] : [rm(join(storage, imageName), { force: true })]),
          ])
        }
      })
    },

    async forget(remote, bundle) {
      const at = paths(remote, bundle)
      const key = operationKey(remote, bundle)
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
      return serialize(key, async () => {
        const meta = await readFile(at.meta, 'utf8')
          .then((text) => JSON.parse(text) as Partial<PreviewMeta>)
          .catch(() => null)
        const image =
          typeof meta?.image === 'string' && basename(meta.image) === meta.image
            ? join(storage, meta.image)
            : at.image
        await Promise.all([rm(image, { force: true }), rm(at.meta, { force: true })])
      })
    },
  }
}
