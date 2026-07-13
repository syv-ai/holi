/**
 * Per-turn context for the agent (spec §Context injection), written to
 * `.holi/context.local.json` in the working dir. The UserPromptSubmit hook
 * reads it — a local file read, so the hook stays inside its <50 ms budget and
 * never talks to the server itself.
 *
 * `*.local.*` is local-only (isLocalOnlyPath in shared), so the mirror never
 * adopts this file as a vault doc and it never syncs.
 *
 * Rewritten on renderer focus changes and task SSE events. Server fetches
 * degrade to empty sections — a stale or thin context block is fine; a hook
 * that blocks a turn is not.
 */
import { vaultRelPath } from '@holi/shared'
import type { Task } from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'

export const CONTEXT_FILE = '.holi/context.local.json'

export interface ContextSnapshotDeps {
  workRoot: string
  listTasks(): Promise<Task[]>
  backrefs(path: string): Promise<Array<{ srcDocId: string; occurrences: number }>>
  docIdForPath(rel: string): string | null
  pathForDocId(docId: string): string | null
  debounceMs?: number
  log?: (msg: string) => void
}

export interface FocusInput {
  focusedPath: string | null
  openPaths: string[]
}

interface RelatedTask {
  id: string
  title: string
  status: string
  due?: string
}

export interface ContextFile {
  focusedPath: string | null
  openPaths: string[]
  relatedTasks: RelatedTask[]
  backrefPaths: string[]
  updatedAt: string
}

export class ContextSnapshot {
  private focus: FocusInput = { focusedPath: null, openPaths: [] }
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: Promise<void> | null = null
  private stopped = false
  private readonly debounceMs: number
  private readonly log: (msg: string) => void

  constructor(private readonly deps: ContextSnapshotDeps) {
    this.debounceMs = deps.debounceMs ?? 150
    this.log = deps.log ?? ((msg) => console.log(`[context] ${msg}`))
  }

  setFocus(focus: FocusInput): void {
    this.focus = focus
    this.schedule()
  }

  /** SSE `tasks` event: the related-task list may have changed. */
  onTasksEvent(): void {
    this.schedule()
  }

  /** Write now (tests, and before a session starts). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.pending // don't race an in-flight write
    if (this.stopped) return
    this.pending = this.write()
    await this.pending
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.pending = this.write().catch((err) => this.log(`snapshot write failed: ${err}`))
    }, this.debounceMs)
  }

  private async write(): Promise<void> {
    const { focusedPath, openPaths } = this.focus
    const context: ContextFile = {
      focusedPath,
      openPaths,
      relatedTasks: [],
      backrefPaths: [],
      updatedAt: new Date().toISOString(),
    }

    if (focusedPath) {
      const docId = this.deps.docIdForPath(focusedPath)
      context.relatedTasks = await this.relatedTasks(docId)
      context.backrefPaths = await this.backrefPaths(focusedPath)
    }

    await writeAtomic(this.deps.workRoot, vaultRelPath(CONTEXT_FILE), `${JSON.stringify(context, null, 2)}\n`)
  }

  private async relatedTasks(focusedDocId: string | null): Promise<RelatedTask[]> {
    if (!focusedDocId) return []
    try {
      const tasks = await this.deps.listTasks()
      return tasks
        .filter((t) => t.status !== 'done')
        .filter((t) => t.related.some((r) => r.kind === 'note' && r.id === focusedDocId))
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          ...(t.due ? { due: t.due } : {}),
        }))
    } catch (err) {
      this.log(`task fetch failed (context degrades to empty): ${err}`)
      return []
    }
  }

  private async backrefPaths(focusedPath: string): Promise<string[]> {
    try {
      const refs = await this.deps.backrefs(focusedPath)
      return refs
        .map((r) => this.deps.pathForDocId(r.srcDocId))
        .filter((p): p is string => p !== null)
    } catch (err) {
      this.log(`backref fetch failed (context degrades to empty): ${err}`)
      return []
    }
  }
}
