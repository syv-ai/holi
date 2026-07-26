/**
 * The per-turn focus file the UserPromptSubmit hook reads: the note the user has
 * focused in the editor, written to `.holi/context.local.json` in the vault's
 * clone. This is the ONE piece of per-turn state the agent cannot discover
 * itself (it is editor-UI focus, which only Holi holds); tasks, backreferences
 * and sync state the agent finds with its own native tools, and vault
 * conventions live in AGENTS.md (prd/agent.md §Per-turn context).
 *
 * `*.local.*` is local-only (isLocalOnlyPath in shared), so the mirror never
 * adopts this file as a vault doc and it never syncs. Writes are debounced and
 * atomic: a stale focus line is fine, a hook that blocks a turn is not.
 */
import { vaultRelPath } from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'

export const CONTEXT_FILE = '.holi/context.local.json'

export interface FocusInput {
  focusedPath: string | null
  openPaths: string[]
}

export interface ContextFile {
  focusedPath: string | null
  openPaths: string[]
  updatedAt: string
}

export class ContextSnapshot {
  private focus: FocusInput = { focusedPath: null, openPaths: [] }
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: Promise<void> | null = null
  private stopped = false
  private readonly debounceMs: number
  private readonly log: (msg: string) => void

  constructor(
    private readonly deps: { workRoot: string; debounceMs?: number; log?: (msg: string) => void },
  ) {
    this.debounceMs = deps.debounceMs ?? 150
    this.log = deps.log ?? ((msg) => console.log(`[context] ${msg}`))
  }

  setFocus(focus: FocusInput): void {
    this.focus = focus
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
    const context: ContextFile = {
      focusedPath: this.focus.focusedPath,
      openPaths: this.focus.openPaths,
      updatedAt: new Date().toISOString(),
    }
    await writeAtomic(this.deps.workRoot, vaultRelPath(CONTEXT_FILE), `${JSON.stringify(context, null, 2)}\n`)
  }
}
