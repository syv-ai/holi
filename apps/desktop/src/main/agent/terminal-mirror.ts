/**
 * Headless xterm mirror of the agent PTY, owned by main (the VS Code pty-host
 * pattern, via Dash).
 *
 * The renderer's xterm is a *view*; this is the record. Every PTY chunk is fed
 * here, so main can always answer "what does this terminal look like right
 * now" — which the panel replays on attach. Without it, anything the session
 * printed before the panel mounted (or across a renderer reload) is simply
 * gone: the bytes were sent to a window that wasn't listening.
 *
 * @xterm/headless has no DOM dependency, so this loads under vitest.
 */
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'

const SCROLLBACK = 5_000

export class TerminalMirror {
  private term: Terminal | null
  private addon: SerializeAddon

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK,
      allowProposedApi: true, // the serialize addon needs it
    })
    this.addon = new SerializeAddon()
    this.term.loadAddon(this.addon)
  }

  write(data: string): void {
    this.term?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.term?.resize(Math.max(1, cols), Math.max(1, rows))
  }

  /** Flush the parser's async queue first — a chunk still in it would be lost. */
  serialize(): Promise<string> {
    const term = this.term
    if (!term) return Promise.resolve('')
    return new Promise((resolve) => term.write('', () => resolve(this.addon.serialize())))
  }

  /** Sync variant for teardown paths that can't await; may miss the last chunk. */
  serializeNow(): string {
    return this.term ? this.addon.serialize() : ''
  }

  dispose(): void {
    this.term?.dispose()
    this.term = null
  }
}
