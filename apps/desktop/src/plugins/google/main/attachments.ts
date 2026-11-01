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
import { readFile, stat } from 'node:fs/promises'
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
  const files: { path: string; abs: string }[] = []
  let total = 0
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
    const info = await stat(abs).catch(() => null)
    if (info === null) throw new CapabilityError('NOT_FOUND', path)
    if (!info.isFile()) {
      throw new CapabilityError('BAD_REQUEST', `${path} is not a file, so it cannot be attached`)
    }
    total += info.size
    files.push({ path: rel, abs })
  }
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new CapabilityError(
      'BAD_REQUEST',
      `the attachments come to ${megabytes(total)}, over the 18 MB that fits in Gmail's 25 MB message once encoded`,
      'attach fewer or smaller files, or share a link to them instead',
    )
  }
  return Promise.all(
    files.map(async ({ path, abs }) => ({
      filename: basename(path),
      mimeType: attachmentType(path),
      data: (await readFile(abs)).toString('base64'),
    })),
  )
}
