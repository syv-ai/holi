/**
 * The signatures a person has made in the PDF viewer, kept between openings.
 *
 * embedpdf's signature plugin holds its entries in memory, so a signature made
 * in one PDF was gone when that PDF closed. The renderer hands the list here in
 * the library's own serialized form (`serializeEntries`: image bytes as base64)
 * and loads it back into each viewer it opens.
 *
 * In `userData`, never a vault, for the same reason as the mail image senders
 * beside it: a vault is a shared git repo, and an image of someone's signature
 * pushed to teammates is a disclosure, not a preference. One list per machine
 * and person, across vaults.
 *
 * Opaque past its shape. Main does not draw or place signatures, so it checks
 * only that the file is a list of objects with an id; anything else in an
 * entry is the library's business.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface SignatureStore {
  /** The stored entries as a JSON array; `[]` when there are none. */
  read(): Promise<string>
  /** Replace the stored entries with `json`, which must be a JSON array. */
  write(json: string): Promise<void>
}

const isEntry = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'

export function createSignatureStore(path: string): SignatureStore {
  return {
    async read() {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        return '[]'
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        // A hand-edit gone wrong costs the bad entry, not every signature.
        return JSON.stringify(Array.isArray(parsed) ? parsed.filter(isEntry) : [])
      } catch {
        // A corrupt file costs the saved signatures, never the viewer.
        return '[]'
      }
    },

    async write(json) {
      const parsed: unknown = JSON.parse(json)
      if (!Array.isArray(parsed)) throw new Error('signatures must be a list')
      await mkdir(dirname(path), { recursive: true })
      // Written aside and renamed: a crash mid-write must not leave a truncated
      // file, which `read` would discard along with every signature in it.
      const temporary = `${path}.tmp`
      await writeFile(temporary, `${JSON.stringify(parsed.filter(isEntry))}\n`, 'utf8')
      await rename(temporary, path)
    },
  }
}
