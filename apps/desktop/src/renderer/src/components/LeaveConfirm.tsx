/**
 * The question leaving the open vault asks while something running in it
 * would be lost: each running plugin's `leaveGuard` sentence, such as the
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

/** Which act is being confirmed. Both leave this vault; they differ in what the
 *  person just pressed. */
export type LeaveIntent = 'switch' | 'add'

const WORDING = {
  switch: { title: 'Switch vaults?', lead: '', go: 'Switch anyway' },
  add: {
    title: 'Add a vault?',
    lead: 'Adding a vault opens it, and leaves this one.',
    go: 'Continue',
  },
} as const

export function LeaveConfirm(props: {
  intent: LeaveIntent
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const wording = WORDING[props.intent]
  /**
   * Read once, when the question is asked. The reasons are live, and a turn
   * landing while the dialog is open would rewrite the sentence under the
   * reader.
   */
  const reasons = useAtomValue(leaveReasonsAtom)
  const [said] = useState(() => reasons)

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
