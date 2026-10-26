/**
 * The pdf plugin's capabilities, as the renderer calls them
 * (`../main/capabilities.ts`), and the three core calls it makes: a PDF's
 * bytes in and out, and the note a PDF is converted from.
 */
import { capClient, trpc } from '@/plugin-api'
import type { PdfCapabilities } from '../main/capabilities'

export const pdfCap = capClient<PdfCapabilities>('pdf')

/** A vault PDF's bytes. */
export function readPdf(remote: string, path: string) {
  return trpc.files.read.query({ remote, path })
}

/** Writes a PDF's bytes; answers the mtime the vault now has. */
export function writePdf(remote: string, path: string, bytes: Uint8Array) {
  return trpc.files.write.mutate({ remote, path, bytes })
}

/** A note's text, to pre-fill a template's fields from its frontmatter. */
export function readNoteText(remote: string, path: string) {
  return trpc.notes.read.query({ remote, path })
}
