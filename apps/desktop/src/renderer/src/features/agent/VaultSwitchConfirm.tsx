/**
 * "You have sessions running here" — the question a vault switch asks (D100).
 *
 * **A switch ends every one of the vault's sessions**, and that is not a choice
 * Holi is making for convenience: `VaultHost` holds exactly one `ActiveVault`
 * and `open()` closes the current one first, so a session left running in the
 * vault you walked away from has no repo, no watcher and no sync loop behind it.
 * Main has always ended them. Nothing has ever said so first.
 *
 * It is asked only for a session that is mid-turn or waiting on you, which is
 * the same line the drawer's close button draws: an idle conversation ends
 * quietly and comes back with Resume, and interrupting one of these costs work
 * part way through or drops a question nobody answered.
 */
import { useAtomValue } from 'jotai'
import { useState } from 'react'
import { Button, Dialog } from '@/primitives'
import { sessionsWorthAsking } from '@/lib/agent-notices'
import { agentSessionsAtom } from '@/state/agent'

/** What the body says about the sessions that are in the way. Plural is a count
 *  rather than a list: three names in a sentence is a list to read, and the
 *  sidebar is already showing them. */
function why(busy: { name: string; state: string }[]): string {
  const one = busy[0]
  if (busy.length === 1 && one !== undefined) {
    return one.state === 'needs-you'
      ? `${one.name} is waiting for you to answer something.`
      : `${one.name} is part way through a turn.`
  }
  return `${busy.length} sessions are still running.`
}

export function VaultSwitchConfirm(props: {
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  /**
   * Read once, when the question is asked.
   *
   * The list is live, and a turn can land while the dialog is open — which
   * would rewrite the sentence under the reader, at worst into "0 sessions are
   * still running" over two buttons asking about them. What it says is what was
   * true when it interrupted you.
   */
  const sessions = useAtomValue(agentSessionsAtom)
  const [busy] = useState(() => sessionsWorthAsking(sessions))

  return (
    <Dialog open onClose={props.onCancel} size="sm">
      <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
        <Dialog.Header>Switch vaults?</Dialog.Header>
        <Dialog.Body>
          <p className="text-xs text-muted-foreground">
            {why(busy)} Switching ends every session in this vault. What they have already written
            stays in it, and Resume in the agent drawer picks a conversation up again.
          </p>
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="ghost" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={props.onConfirm}>
            Switch anyway
          </Button>
        </Dialog.Footer>
      </div>
    </Dialog>
  )
}
