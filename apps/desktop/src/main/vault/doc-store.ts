/**
 * Persisted Yjs state per doc (D59) — the thing that makes an offline edit survive a
 * quit. Notes were memory-only: an edit made offline never reached the relay, so it never
 * reached main's mirror, so it was never written to disk, and it died with the process.
 *
 * **This is not `BaseStore`, and the difference matters.** BaseStore also persists Y state
 * per doc, but it is the *frozen merge base* — the exact bytes last written to disk — and
 * it is deliberately deleted when an entry closes and never applied back into a Y.Doc. It
 * answers "what did the file look like when I last materialized it". This answers "what
 * does the doc actually contain", survives `closeEntry`, and IS applied back on open.
 * Repurposing BaseStore would have quietly conflated the merge base with the truth.
 *
 * Same discipline as its sibling: one file per doc, tmp+rename so a crash mid-write can
 * never leave a torn state, and `null` on any failure — an unreadable local cache must
 * degrade to "sync from the relay", never take the vault down.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DocMeta } from '@holi/shared'

export class DocStore {
  constructor(private readonly dir: string) {}

  private file(docId: string): string {
    return join(this.dir, `${docId}.json`)
  }

  async load(docId: string): Promise<Uint8Array | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(docId), 'utf8')) as { stateB64: string }
      if (typeof raw.stateB64 !== 'string') return null
      return new Uint8Array(Buffer.from(raw.stateB64, 'base64'))
    } catch {
      return null
    }
  }

  async save(docId: string, state: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `.tmp-${randomBytes(6).toString('hex')}`)
    await writeFile(tmp, JSON.stringify({ stateB64: Buffer.from(state).toString('base64') }), 'utf8')
    await rename(tmp, this.file(docId))
  }

  /** Only when the DOC is gone — never on `closeEntry`. Dropping this on close would
   * throw away the offline edit on the next vault switch, which is the whole point. */
  async remove(docId: string): Promise<void> {
    await rm(this.file(docId), { force: true })
  }
}

/**
 * The vault's doc list, cached (D59).
 *
 * `refresh()` learns the vault's docs from `api.listDocs()` — an HTTP call. So with the
 * server unreachable, `mirror.start()` threw and vault activation failed outright: not
 * "offline with stale data" but no vault at all, which is why persistence alone could
 * never have delivered offline.
 *
 * **This cache is emphatically not server truth**, and the caller must treat it that way.
 * `refresh()` closes every entry absent from its list *and deletes the working copy* —
 * feed a cached or empty list into that half and it deletes the user's notes. The cache
 * may only ever open docs, never close them.
 */
export class DocListStore {
  constructor(private readonly path: string) {}

  async load(): Promise<DocMeta[] | null> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      return Array.isArray(raw) ? (raw as DocMeta[]) : null
    } catch {
      return null
    }
  }

  async save(docs: DocMeta[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${randomBytes(6).toString('hex')}`
    await writeFile(tmp, JSON.stringify(docs), 'utf8')
    await rename(tmp, this.path)
  }
}
