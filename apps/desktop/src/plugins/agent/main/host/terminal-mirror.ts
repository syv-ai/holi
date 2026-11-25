/**
 * Headless xterm mirror of the agent PTY, owned by main (the VS Code pty-host
 * pattern, via Dash).
 *
 * The renderer's xterm is a *view*; this is the record. Every PTY chunk is fed
 * here, so main can always answer "what does this terminal look like right
 * now", which the panel replays on attach. Without it, anything printed before
 * the panel mounted (or across a renderer reload) is gone.
 *
 * @xterm/headless has no DOM dependency, so this loads under vitest.
 */
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'

const SCROLLBACK = 5_000

type TerminalSnapshot = { state: string; through: number }

export class TerminalMirror {
  private term: Terminal | null
  private addon: SerializeAddon
  private received = 0
  private parsed = 0
  private snapshots = new Set<(snapshot: TerminalSnapshot) => void>()

  constructor(cols?: number, rows?: number) {
    this.term = new Terminal({
      // Omitted → xterm's own native default (80×24). The caller passes the
      // drawer's fitted geometry so the record matches the view.
      cols,
      rows,
      scrollback: SCROLLBACK,
      allowProposedApi: true, // the serialize addon needs it
    })
    this.addon = new SerializeAddon()
    this.term.loadAddon(this.addon)
  }

  write(data: string): number {
    const sequence = ++this.received
    this.term?.write(data, () => {
      this.parsed = sequence
    })
    return sequence
  }

  /**
   * The terminal's title, as the program running in it sets it (OSC 0/2).
   *
   * A published terminal protocol, read the way any terminal reads it, and used
   * only as a label: Claude Code sets it to the attached session's name, and to
   * "claude agents" in its list. It never says which session, so nothing
   * is keyed on it.
   */
  onTitle(cb: (title: string) => void): void {
    this.term?.onTitleChange(cb)
  }

  resize(cols: number, rows: number): void {
    this.term?.resize(Math.max(1, cols), Math.max(1, rows))
  }

  /** Flush the parser's async queue first — a chunk still in it would be lost. */
  async serialize(): Promise<string> {
    return (await this.snapshot()).state
  }

  /** The exact parsed prefix lets an attachment stream only bytes after replay. */
  snapshot(): Promise<TerminalSnapshot> {
    const term = this.term
    if (!term) return Promise.resolve({ state: '', through: this.parsed })
    return new Promise((resolve) => {
      this.snapshots.add(resolve)
      term.write('', () => {
        if (!this.snapshots.delete(resolve)) return
        resolve({ state: this.addon.serialize(), through: this.parsed })
      })
    })
  }

  /** Sync variant for teardown paths that can't await; may miss the last chunk. */
  serializeNow(): string {
    return this.term ? this.addon.serialize() : ''
  }

  dispose(): void {
    for (const resolve of this.snapshots) resolve({ state: '', through: this.parsed })
    this.snapshots.clear()
    this.term?.dispose()
    this.term = null
  }
}
