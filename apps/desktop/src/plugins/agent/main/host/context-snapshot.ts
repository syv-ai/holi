/**
 * The per-turn focus file the UserPromptSubmit hook reads: the note the user has
 * focused in the editor, and the lines selected in it, written to `.holi/state/context.local.json` in the vault's
 * clone. This is the ONE piece of per-turn state the agent cannot discover
 * itself (it is editor-UI focus, which only Holi holds); tasks, backreferences
 * and sync state the agent finds with its own native tools, and vault
 * conventions live in AGENTS.md (docs/features/agent-config.md).
 *
 * `*.local.*` is local-only (`isLocalOnlyPath` in shared), so this file never
 * syncs. A secret file (`isSecretPath`) is never written into it, focused or
 * open, so no hook can point the agent at one. Writes are debounced and
 * atomic: a stale focus line is fine, a hook that blocks a turn is not.
 */
import { isSecretPath, vaultRelPath, type LineRange } from '@holi/shared'
import { writeAtomic } from '../../../../main/plugin-api'

/** @public exported for its test */
export const CONTEXT_FILE = '.holi/state/context.local.json'

export interface FocusInput {
  focusedPath: string | null
  /** The lines selected in the focused note; absent or null for a caret. Line
   *  numbers only, never the text: nothing a person selected lands on disk. */
  selection?: LineRange | null
  openPaths: string[]
}

interface ContextFile {
  focusedPath: string | null
  selection: LineRange | null
  openPaths: string[]
  updatedAt: string
}

class SnapshotRevoked extends Error {}

export class ContextSnapshot {
  private focus: FocusInput = { focusedPath: null, openPaths: [] }
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: Promise<void> = Promise.resolve()
  private stopped = false
  private stopWork: Promise<void> | null = null
  private readonly failures: unknown[] = []
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
    this.pending = this.pending.then(() => this.write())
    await this.pending
  }

  stop(): Promise<void> {
    if (this.stopWork !== null) return this.stopWork
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.stopWork = (async () => {
      await this.pending
      if (this.failures.length > 0)
        throw new AggregateError([...this.failures], 'Could not write agent context snapshot.')
    })()
    return this.stopWork
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.pending = this.pending
        .then(() => this.write())
        .catch((err: unknown) => {
          if (err instanceof SnapshotRevoked) return
          this.failures.push(err)
          this.log(`snapshot write failed: ${err}`)
        })
    }, this.debounceMs)
  }

  private async write(): Promise<void> {
    if (this.stopped) return
    const { focusedPath } = this.focus
    const secret = focusedPath !== null && isSecretPath(focusedPath)
    const context: ContextFile = {
      focusedPath: secret ? null : focusedPath,
      selection: secret ? null : (this.focus.selection ?? null),
      openPaths: this.focus.openPaths.filter((path) => !isSecretPath(path)),
      updatedAt: new Date().toISOString(),
    }
    try {
      await writeAtomic(
        this.deps.workRoot,
        vaultRelPath(CONTEXT_FILE),
        `${JSON.stringify(context, null, 2)}\n`,
        () => {
          if (this.stopped) throw new SnapshotRevoked('context snapshot activation was cancelled')
        },
      )
    } catch (error) {
      if (error instanceof SnapshotRevoked) return
      throw error
    }
  }
}
