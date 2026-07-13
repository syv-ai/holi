/** Persisted per-doc frozen bases. The spike kept the base in memory; the real
 * bridge persists {text, yjsState} atomically at every advancement so a crash
 * mid-turn reconciles through a normal turn merge on next vault open (spec
 * §Bridge — base persistence). One JSON file per doc under userData. */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface DocBase {
  text: string
  state: Uint8Array
}

export class BaseStore {
  constructor(private readonly dir: string) {}

  private file(docId: string): string {
    return join(this.dir, `${docId}.json`)
  }

  async load(docId: string): Promise<DocBase | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(docId), 'utf8')) as { text: string; stateB64: string }
      return { text: raw.text, state: new Uint8Array(Buffer.from(raw.stateB64, 'base64')) }
    } catch {
      return null
    }
  }

  async save(docId: string, base: DocBase): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `.tmp-${randomBytes(6).toString('hex')}`)
    await writeFile(
      tmp,
      JSON.stringify({ text: base.text, stateB64: Buffer.from(base.state).toString('base64') }),
      'utf8',
    )
    await rename(tmp, this.file(docId))
  }

  async remove(docId: string): Promise<void> {
    await rm(this.file(docId), { force: true })
  }
}
