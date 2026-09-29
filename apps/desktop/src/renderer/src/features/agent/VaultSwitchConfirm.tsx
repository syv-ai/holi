/**
 * The question a vault switch asks when sessions are running.
 *
 * **A switch stops every one of the vault's sessions** (`claude stop`):
 * `VaultHost` holds exactly one `ActiveVault` and `open()` closes the current
 * one first, so a session left running would have no watcher or sync loop
 * behind it.
 *
 * It is asked only for a session that is mid-turn or waiting on you, the same
 * line the sidebar's Stop draws: an idle conversation stops quietly and picks
 * up again from the agents list.
 *
 * Adding a vault asks the same question at the start of the ritual, not the end:
 * creating a vault opens it, and the moment to say so is before someone has
 * named a repo and waited for a clone.
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

/** Which act is being confirmed. Both leave this vault; they differ in what the
 *  person just pressed. */
export type LeaveIntent = 'switch' | 'add'

const WORDING = {
  switch: {
    title: 'Switch vaults?',
    what: 'Switching stops every session in this vault.',
    go: 'Switch anyway',
  },
  add: {
    title: 'Add a vault?',
    what: 'Adding a vault opens it, which stops every session in this vault.',
    go: 'Continue',
  },
} as const

export function VaultSwitchConfirm(props: {
  intent: LeaveIntent
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const wording = WORDING[props.intent]
  /**
   * Read once, when the question is asked.
   *
   * The list is live, and a turn landing while the dialog is open would rewrite
   * the sentence under the reader, at worst into "0 sessions are still running".
   */
  const sessions = useAtomValue(agentSessionsAtom)
  const [busy] = useState(() => sessionsWorthAsking(sessions))

  return (
    <Dialog open onClose={props.onCancel} size="sm">
      <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
        <Dialog.Header>{wording.title}</Dialog.Header>
        <Dialog.Body>
          <p className="text-xs text-muted-foreground">
            {why(busy)} {wording.what} What they have already written stays in it, and each
            conversation stays in the agents list, where it picks up where it left off.
          </p>
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="ghost" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={props.onConfirm}>
            {wording.go}
          </Button>
        </Dialog.Footer>
      </div>
    </Dialog>
  )
}
