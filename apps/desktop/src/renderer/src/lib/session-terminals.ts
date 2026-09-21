/**
 * Every session terminal that has been built, by session id — so that a paste
 * into a session can put the keyboard where the text just landed.
 *
 * Opening a session's tab focuses its terminal already (`SessionTerminal`'s
 * visible effect), and that covers every ask that arrives in a tab you were
 * not looking at. The case it misses is the one where the tab was ALREADY
 * showing: nothing becomes visible, so nothing focuses, and the keystrokes
 * meant to finish a `/rename ` go to whatever had focus before — the tab you
 * just double-clicked, usually. This is the other half: a terminal registers
 * itself when it is built, and a send asks for it by id.
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
 * Focus a session's terminal. False when it has none yet, which is fine: the
 * terminal being built for it focuses itself on its first show, and a hidden
 * one does the same the moment its tab comes forward.
 */
export function focusSessionTerminal(id: string): boolean {
  const focus = terminals.get(id)
  if (focus === undefined) return false
  focus()
  return true
}
