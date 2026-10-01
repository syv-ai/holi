/**
 * What the agent terminal should do with a key chord, decided without xterm.
 *
 * xterm has no bytes for the macOS editing chords: Enter is `\r` with or
 * without Shift (no CSI-u or `modifyOtherKeys`), and ⌘ is not a terminal
 * modifier. So the terminal writes sequences Claude Code's TUI understands and
 * takes the event from xterm. Each sequence was confirmed against a live
 * session: ESC CR opens a new input line, `\x1b[H`/`\x1b[F` move within the
 * current line, the meta bindings do readline word motion.
 *
 * The awkward cases are what must NOT be taken: ⌃C with no selection is the
 * interrupt, and Ctrl+arrow is word motion xterm already encodes.
 */

/** `null` means "leave it to xterm", which is the answer for almost every key. */
export type TerminalKeyAction =
  | { kind: 'write'; seq: string }
  | { kind: 'scroll'; to: 'top' | 'bottom' }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | null

/** The parts of a `KeyboardEvent` this decision reads. */
export type KeyChord = Pick<
  KeyboardEvent,
  'type' | 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
>

export function terminalKeyAction(e: KeyChord, hasSelection: boolean): TerminalKeyAction {
  if (e.type !== 'keydown') return null
  const mod = e.metaKey || e.ctrlKey

  // ⇧⏎ → ESC CR, what Claude Code's own `/terminal-setup` configures. Ahead of
  // the `mod` gate, which this chord does not pass.
  if (e.key === 'Enter' && e.shiftKey && !mod) return { kind: 'write', seq: '\x1b\r' }

  // ⌥←/→/⌫ — word motion and word delete, the readline meta bindings.
  if (e.altKey && !mod) {
    if (e.key === 'ArrowLeft') return { kind: 'write', seq: '\x1bb' }
    if (e.key === 'ArrowRight') return { kind: 'write', seq: '\x1bf' }
    if (e.key === 'Backspace') return { kind: 'write', seq: '\x1b\x7f' }
  }

  if (!mod) return null

  // ⌘←/→ → Home/End. `metaKey` alone: xterm already encodes Ctrl+arrow.
  if (e.metaKey && !e.ctrlKey) {
    if (e.key === 'ArrowLeft') return { kind: 'write', seq: '\x1b[H' }
    if (e.key === 'ArrowRight') return { kind: 'write', seq: '\x1b[F' }
    // ⌘⌫ → Ctrl-U, kill to start of line; recoverable with Ctrl-Y.
    if (e.key === 'Backspace') return { kind: 'write', seq: '\x15' }
    // Not a PTY write: the scrollback is xterm's.
    if (e.key === 'ArrowUp') return { kind: 'scroll', to: 'top' }
    if (e.key === 'ArrowDown') return { kind: 'scroll', to: 'bottom' }
  }

  // ⌘/⌃C copies a selection. Without one it must fall through: it is the
  // interrupt.
  if (e.code === 'KeyC' && hasSelection) return { kind: 'copy' }
  if (e.code === 'KeyV') return { kind: 'paste' }
  return null
}
