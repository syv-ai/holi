/**
 * The question leaving the open vault, or turning a plugin off, asks while
 * something running would be lost: each `leaveGuard` sentence, such as the
 * agent's busy sessions.
 *
 * Adding a vault asks it at the start of the ritual, not the end: creating a
 * vault opens it, and the moment to say so is before someone has named a repo
 * and waited for a clone.
 */
import { useAtomValue } from 'jotai'
import { useState } from 'react'
import { Button, Dialog } from '@/primitives'
import { leaveReasonsAtom } from '@/state/plugins'

/** Which act is being confirmed: two leave this vault, one stops a plugin
 *  in it. */
export type LeaveIntent = 'switch' | 'add' | 'turn-off'

const wordingFor = (intent: LeaveIntent, subject: string) =>
  ({
    switch: { title: 'Switch vaults?', lead: '', go: 'Switch anyway' },
    add: {
      title: 'Add a vault?',
      lead: 'Adding a vault opens it, and leaves this one.',
      go: 'Continue',
    },
    'turn-off': { title: `Turn off ${subject}?`, lead: '', go: 'Turn off' },
  })[intent]

export function LeaveConfirm(props: {
  intent: LeaveIntent
  /** What is turned off, for `turn-off`. */
  subject?: string
  /** What it costs, when only some running plugins stop; every running
   *  plugin's by default, as leaving stops them all. */
  reasons?: readonly string[]
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const wording = wordingFor(props.intent, props.subject ?? 'this plugin')
  /**
   * Read once, when the question is asked. The reasons are live, and a turn
   * landing while the dialog is open would rewrite the sentence under the
   * reader.
   */
  const all = useAtomValue(leaveReasonsAtom)
  const [said] = useState(() => props.reasons ?? all)

  return (
    <Dialog open onClose={props.onCancel} size="sm">
      <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
        <Dialog.Header>{wording.title}</Dialog.Header>
        <Dialog.Body>
          <p className="text-xs text-muted-foreground">
            {[wording.lead, ...said].filter((s) => s !== '').join(' ')}
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
