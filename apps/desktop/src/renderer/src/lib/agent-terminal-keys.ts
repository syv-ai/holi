/**
 * What the agent terminal should do with a key chord, decided without xterm.
 *
 * xterm turns a keystroke into bytes, and for the macOS editing chords there
 * are no bytes to turn it into: it sends `\r` for Enter whether or not Shift is
 * held (there is no CSI-u or `modifyOtherKeys` encoding enabled here), and ⌘ is
 * not a terminal modifier at all, so a ⌘+arrow chord is dropped on the floor.
 * Claude Code's Ink input is not failing to read those keys — the information
 * never reaches it. So the panel writes the sequences the TUI *does* understand
 * and takes the event away from xterm.
 *
 * Every sequence below was confirmed against a live Claude Code session rather
 * than reasoned about: ESC CR opens a second input line, `\x1b[H`/`\x1b[F` move
 * within the current line (not the whole input), and the meta bindings do
 * readline word motion.
 *
 * Split out of the handler so the truth table can be tested without a Terminal:
 * the awkward cases are the ones about what must NOT be taken — ⌃C with no
 * selection is the interrupt, and Ctrl+arrow is word motion xterm already
 * encodes.
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

  // ⇧⏎ → ESC CR: the same sequence Claude Code's own `/terminal-setup` writes
  // into iTerm2 and VS Code, which is why the Ink input reads it as a newline.
  // Ahead of the `mod` gate below, because this chord does not pass it.
  if (e.key === 'Enter' && e.shiftKey && !mod) return { kind: 'write', seq: '\x1b\r' }

  // ⌥←/→/⌫ — word motion and word delete, the readline meta bindings.
  if (e.altKey && !mod) {
    if (e.key === 'ArrowLeft') return { kind: 'write', seq: '\x1bb' }
    if (e.key === 'ArrowRight') return { kind: 'write', seq: '\x1bf' }
    if (e.key === 'Backspace') return { kind: 'write', seq: '\x1b\x7f' }
  }

  if (!mod) return null

  // ⌘←/→ → Home/End. Gated on `metaKey` alone rather than `mod`: Ctrl+arrow is
  // already word motion in a terminal and xterm encodes it properly, so taking
  // it here would be a downgrade.
  if (e.metaKey && !e.ctrlKey) {
    if (e.key === 'ArrowLeft') return { kind: 'write', seq: '\x1b[H' }
    if (e.key === 'ArrowRight') return { kind: 'write', seq: '\x1b[F' }
    // ⌘⌫ → Ctrl-U, readline's kill-to-start-of-line, which is exactly what
    // macOS means by it. A kill and not a delete: Claude Code offers it back on
    // Ctrl-Y, so a mis-hit is recoverable the way ⌘⌫ is everywhere else.
    if (e.key === 'Backspace') return { kind: 'write', seq: '\x15' }
    // Not a PTY write: the scrollback is xterm's, and Claude Code neither knows
    // nor needs to know that it is being scrolled.
    if (e.key === 'ArrowUp') return { kind: 'scroll', to: 'top' }
    if (e.key === 'ArrowDown') return { kind: 'scroll', to: 'bottom' }
  }

  // ⌘/⌃C with a selection copies, like a native terminal. WITHOUT one it must
  // fall through untouched — that is the interrupt, and swallowing it would
  // leave no way to stop a running turn.
  if (e.code === 'KeyC' && hasSelection) return { kind: 'copy' }
  if (e.code === 'KeyV') return { kind: 'paste' }
  return null
}
