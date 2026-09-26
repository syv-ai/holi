/**
 * Every session terminal that has been built, by session id — so that a paste
 * into a session can put the keyboard where the text just landed.
 *
 * A terminal focuses itself when its tab becomes visible. This covers the tab
 * that was already showing, where nothing becomes visible and keystrokes (say,
 * finishing a `/rename `) would go to whatever had focus before.
 */

type Focus = () => void

const terminals = new Map<string, Focus>()

/** Register a session's terminal. Returns the deregistration. */
export function registerSessionTerminal(id: string, focus: Focus): () => void {
  terminals.set(id, focus)
  return () => {
    // Only its own entry: a terminal rebuilt under the same id must not be
    // dropped by the previous one's teardown.
    if (terminals.get(id) === focus) terminals.delete(id)
  }
}

/**
 * Focus a session's terminal. False when it has none yet, which is fine: it
 * focuses itself on first show.
 */
export function focusSessionTerminal(id: string): boolean {
  const focus = terminals.get(id)
  if (focus === undefined) return false
  focus()
  return true
}
