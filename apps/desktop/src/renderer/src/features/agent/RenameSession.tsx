/**
 * Rename one agent session (D101).
 *
 * **Holi cannot rename a session by itself.** `/rename` is the only route
 * Claude Code offers, there is no shell equivalent (`claude agents`, `attach`,
 * `stop`, `respawn`, `rm` — and nothing for a name), and the command has to be
 * typed into the session itself.
 *
 * So this writes the command into the session's box and stops there, **unsent**,
 * which is the rule everything Holi sends already follows. The alternative was
 * appending an Enter, and Holi cannot see the composer: a half-written draft
 * sitting in it would have been submitted along with the command, as a prompt
 * nobody meant to send. A rename is not worth that, and the cost of not doing
 * it is one keystroke in a terminal the dialog has just put in front of you.
 */
import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { Button, Dialog, Input } from '@/primitives'
import { sendToAgentAtom } from '@/state/agent-send'

export function RenameSession({
  sessionId,
  current,
  onClose,
}: {
  sessionId: string
  current: string
  onClose: () => void
}): React.JSX.Element {
  /** Seeded with the name it has, as the app rename does: a rename is usually a
   *  small edit to something that already exists. */
  const [value, setValue] = useState(current)
  const [error, setError] = useState<string | null>(null)
  const sendToAgent = useSetAtom(sendToAgentAtom)

  const commit = async () => {
    const name = value.trim()
    if (name === '') return
    const res = await sendToAgent({ text: `/rename ${name}`, target: sessionId })
    if (!res.ok) {
      setError(res.message ?? 'That could not be sent.')
      return
    }
    onClose()
  }

  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <Dialog.Header>Rename {current}</Dialog.Header>
      <Dialog.Body>
        <Input
          autoFocus
          aria-label="new session name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit()
          }}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          The name is Claude Code's own, so Holi puts <code>/rename</code> in this session's box and
          opens its tab. Press Enter there to apply it.
        </p>
        {error !== null && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={value.trim() === ''} onClick={() => void commit()}>
          Put it in the box
        </Button>
      </Dialog.Footer>
    </div>
  )
}
