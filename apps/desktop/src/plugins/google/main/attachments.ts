/**
 * Vault files attached to the agent's mail (`--attach <path>` on `draft`,
 * `send` and `reply`).
 *
 * A file leaves the machine here, so every path passes the fences a read
 * does (`knownPath`: a real vault path in the snapshot, not machine state, not
 * the agent surface, not an app's records, not a secret) and one more: nothing
 * local to this machine (the `.local.` marker) goes out by mail, since a
 * person never meant it to leave even for their own teammates. Then the file
 * opened must be the file named (`exactPath`: no symlink on the way, the case
 * it has on disk) and a regular file.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { constants } from 'node:fs'
import { open, lstat, realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { isLocalOnlyPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import {
  CapabilityError,
  knownPath,
  mimeFor,
  type CapabilityContext,
} from '../../../main/plugin-api'
import type { MailPart } from './mime'

/**
 * Gmail's limit on what one message may carry. Counted on the files as they
 * are, before base64: the number a person knows their files by.
 */
// Gmail's 25 MB is the whole message, encoded: base64 makes the files about
// a third larger, so they may come to 18 MB.
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024

/** Types a mail client opens by its declared type. Anything else is
 *  `mimeFor`'s (images and PDF), then `application/octet-stream`. */
const DOCUMENT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  ics: 'text/calendar',
}

function attachmentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return DOCUMENT_TYPES[ext] ?? mimeFor(path)
}

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/**
 * The files at `paths`, ready for `buildRfc822`, or a refusal naming the path
 * that stopped them. Every path is checked, and the total size, before any
 * file is read.
 */
export async function vaultAttachments(
  ctx: CapabilityContext,
  paths: readonly string[],
): Promise<MailPart[]> {
  const files: { path: string; handle: Awaited<ReturnType<typeof open>> }[] = []
  let total = 0
  try {
    for (const path of paths) {
      // The marker is in a name, so the path as given says it: normalising
      // never renames a segment, and `knownPath` holds it to the case on disk.
      if (isLocalOnlyPath(path)) {
        throw new CapabilityError(
          'FORBIDDEN',
          `${path} is local to this machine and never leaves it, so it cannot be attached`,
        )
      }
      const rel = await knownPath(ctx, path)
      const abs = await exactPath(ctx.root, rel)
      if (abs === null) throw new CapabilityError('FORBIDDEN', path)
      // Open without following a last-component symlink, then use this retained
      // descriptor for both validation and reading. Recheck ancestors around the
      // open to reject directory replacement during path resolution.
      const before = await realpath(ctx.root)
      const expectedTarget = await lstat(abs).catch(() => null)
      if (expectedTarget === null || expectedTarget.isSymbolicLink() || !expectedTarget.isFile()) {
        throw new CapabilityError('FORBIDDEN', path)
      }
      const segments = rel.split('/')
      let cursor = before
      const ancestors: { path: string; dev: number; ino: number }[] = []
      for (const segment of segments.slice(0, -1)) {
        cursor = `${cursor}/${segment}`
        const ancestor = await lstat(cursor).catch(() => null)
        if (!ancestor || ancestor.isSymbolicLink() || !ancestor.isDirectory()) {
          throw new CapabilityError('FORBIDDEN', path)
        }
        ancestors.push({ path: cursor, dev: ancestor.dev, ino: ancestor.ino })
      }
      const handle = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
        () => null,
      )
      if (!handle) throw new CapabilityError('NOT_FOUND', path)
      try {
        const info = await handle.stat()
        // Verify the object reached by the kernel open against the identity
        // captured before it, not only against the current pathname.
        if (!info.isFile()) {
          throw new CapabilityError(
            'BAD_REQUEST',
            `${path} is not a file, so it cannot be attached`,
          )
        }
        const afterRoot = await realpath(ctx.root)
        const currentLeaf = await lstat(abs).catch(() => null)
        // Compare the descriptor identity after pathname rechecks as well: this
        // catches an ancestor ABA swap whose outside leaf was opened, then the
        // original directory restored before the current path is inspected.
        if (info.dev !== expectedTarget.dev || info.ino !== expectedTarget.ino)
          throw new CapabilityError('FORBIDDEN', path)
        const unchanged =
          afterRoot === before &&
          currentLeaf !== null &&
          currentLeaf.isFile() &&
          !currentLeaf.isSymbolicLink() &&
          currentLeaf.dev === info.dev &&
          currentLeaf.ino === info.ino &&
          (
            await Promise.all(
              ancestors.map(async (item) => {
                const current = await lstat(item.path).catch(() => null)
                return (
                  current !== null &&
                  current.isDirectory() &&
                  !current.isSymbolicLink() &&
                  current.dev === item.dev &&
                  current.ino === item.ino
                )
              }),
            )
          ).every(Boolean)
        if (!unchanged) throw new CapabilityError('FORBIDDEN', path)
        total += info.size
        files.push({ path: rel, handle })
      } catch (error) {
        await handle.close()
        throw error
      }
    }
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new CapabilityError(
        'BAD_REQUEST',
        `the attachments come to ${megabytes(total)}, over the 18 MB that fits in Gmail's 25 MB message once encoded`,
        'attach fewer or smaller files, or share a link to them instead',
      )
    }
  } catch (error) {
    await Promise.all(files.map(({ handle }) => handle.close()))
    throw error
  }
  // The initial stat is only an early rejection; enforce the aggregate again
  // against bytes actually read, since a file can grow after it is opened.
  total = 0
  try {
    return await Promise.all(
      files.map(async ({ path, handle }) => {
        const chunks: Buffer[] = []
        let size = 0
        const stream = handle.createReadStream({ autoClose: false })
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk)
          size += bytes.length
          total += bytes.length
          if (size > MAX_ATTACHMENT_BYTES || total > MAX_ATTACHMENT_BYTES) {
            throw new CapabilityError(
              'BAD_REQUEST',
              `${path} grew beyond the attachment size limit`,
            )
          }
          chunks.push(bytes)
        }
        return {
          filename: basename(path),
          mimeType: attachmentType(path),
          data: Buffer.concat(chunks).toString('base64'),
        }
      }),
    )
  } finally {
    await Promise.all(files.map(({ handle }) => handle.close()))
  }
}
