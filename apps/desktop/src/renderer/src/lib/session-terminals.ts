/**
 * Every session terminal that has been built, by terminal id, and the bytes
 * between them and main.
 *
 * Output arrives as the agent's `pty-data` event, every terminal's on one
 * channel, and goes straight to the xterm it names: no atom, because a busy
 * session prints far more often than anything should re-render. Keystrokes
 * and resizes go back as events, in the order they happened, which a request
 * per keystroke would not keep.
 *
 * Focus is here too, so a paste into a session can put the keyboard where the
 * text just landed. A terminal focuses itself when its tab becomes visible;
 * this covers the tab that was already showing, where nothing becomes visible
 * and keystrokes (say, finishing a `/rename `) would go to whatever had focus
 * before.
 */

/** The agent's plugin id, whose events these are. */
const AGENT = 'agent'

export interface SessionTerminalHandle {
  focus(): void
  /** Bytes from the PTY, for xterm to decode. */
  write(data: Uint8Array | string): void
}

const terminals = new Map<string, SessionTerminalHandle>()

/** Register a terminal. Returns the deregistration. */
export function registerSessionTerminal(id: string, handle: SessionTerminalHandle): () => void {
  terminals.set(id, handle)
  return () => {
    // Only its own entry: a terminal rebuilt under the same id must not be
    // dropped by the previous one's teardown.
    if (terminals.get(id) === handle) terminals.delete(id)
  }
}

/**
 * Focus a terminal. False when it has none yet, which is fine: it focuses
 * itself on first show.
 */
export function focusSessionTerminal(id: string): boolean {
  const handle = terminals.get(id)
  if (handle === undefined) return false
  handle.focus()
  return true
}

/** The `pty-data` event: one terminal's output. A terminal not built yet
 *  drops it, because its attach replays main's record of everything. */
export function receivePtyData(payload: unknown): void {
  const p = payload as { id?: unknown; data?: unknown }
  if (typeof p?.id !== 'string') return
  if (typeof p.data !== 'string' && !(p.data instanceof Uint8Array)) return
  terminals.get(p.id)?.write(p.data)
}

/** Send keystrokes, or pasted text, to a terminal in the vault `remote`. */
export function typeIntoTerminal(remote: string, id: string, data: string): void {
  window.holi.plugin.send(AGENT, { remote, name: 'pty-write', payload: { id, data } })
}

/** Tell a terminal's PTY its new size. */
export function resizeTerminal(remote: string, id: string, cols: number, rows: number): void {
  window.holi.plugin.send(AGENT, { remote, name: 'pty-resize', payload: { id, cols, rows } })
}
