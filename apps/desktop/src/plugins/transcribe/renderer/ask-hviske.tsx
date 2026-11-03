/**
 * Ask Hviske to change the minutes, in the minutes' own header: "drop the
 * budget talk", "Simon owns the CI fix". It goes to the scribe at once as a
 * change to the topics the minutes are built from (`meeting.tell`, kind
 * `minutes`), which it writes again; editing a topic by hand is beside it.
 */
import { useAtomValue } from 'jotai'
import { SendHorizontal } from 'lucide-react'
import { useState } from 'react'
import { activeRemoteAtom } from '@/plugin-api'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { meetingCap } from './meeting-cap'
import { SCRIBE_NAME } from './names'
import { message } from './state'

export function AskHviske({
  meetingId,
  onAsked,
  onError,
}: {
  meetingId: string
  /** The request reached Hviske. */
  onAsked: () => void
  /** It did not, and why; null as a new one goes. */
  onError: (error: string | null) => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)

  const send = async () => {
    const said = text.trim()
    if (said === '' || remote === null || sending) return
    setSending(true)
    onError(null)
    try {
      await meetingCap.tell(remote, { meetingId, text: said, kind: 'minutes' })
      setText('')
      onAsked()
    } catch (e) {
      onError(`${SCRIBE_NAME} didn’t get that: ${message(e)}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <InputGroup className="max-w-md min-w-40 flex-1">
      <InputGroupInput
        aria-label={`Ask ${SCRIBE_NAME}`}
        placeholder={`Ask ${SCRIBE_NAME} to change the topics… (e.g. drop the budget talk, Simon owns the CI fix)`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void send()
        }}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          aria-label={`Send to ${SCRIBE_NAME}`}
          size="icon-xs"
          disabled={sending || text.trim() === ''}
          onClick={() => void send()}
        >
          <SendHorizontal aria-hidden />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
