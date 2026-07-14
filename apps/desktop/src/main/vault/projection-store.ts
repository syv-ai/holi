/** The persisted last-known task file projection.
 *
 * The exact analogue of BaseStore, and it exists for the same reason. The
 * inbound path turns a file write into a **per-field patch** by diffing the file
 * against what we last wrote. Hold that only in memory and the diff evaporates
 * across a restart: a file edited while the app was closed could then be applied
 * only as a whole-record overwrite (destroying a teammate's concurrent change to
 * a field the writer never touched) or discarded (losing a legitimate edit).
 * Persisting it makes restart and offline well-defined.
 *
 * It doubles as the echo guard — the projector's own writes come back through
 * the watcher, and text-equal-to-stored is how we know a change was ours.
 *
 * One JSON file per vault: tasks are few, and a whole-map rewrite keeps the
 * store atomically consistent with itself.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ProjectedTask {
  /** Where we last wrote it — a title edit moves the file, so this is not
   * derivable from the current record. */
  rel: string
  /** Exactly the bytes we last wrote. */
  text: string
  version: number
}

const FILE = 'tasks.json'

export class ProjectionStore {
  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, FILE)
  }

  /** A corrupt or absent store degrades to empty rather than throwing: the
   * projector then rewrites every file from server truth, which is the correct
   * recovery — we simply lose the ability to diff writes made while we were
   * away, not any server state. */
  async load(): Promise<Map<string, ProjectedTask>> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, ProjectedTask>
      return new Map(Object.entries(raw))
    } catch {
      return new Map()
    }
  }

  async save(projected: Map<string, ProjectedTask>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `.tmp-${randomBytes(6).toString('hex')}`)
    await writeFile(tmp, JSON.stringify(Object.fromEntries(projected)), 'utf8')
    await rename(tmp, this.file)
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true })
  }
}
