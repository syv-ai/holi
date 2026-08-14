/**
 * A brand-new message, as a dialog (D71).
 *
 * **A dialog is right here and was wrong for reply.** A reply needs the thing
 * it is replying to on screen, so it mounts inline at the foot of the thread. A
 * fresh message has no context to preserve, so a modal costs nothing and gets
 * the composer out of a list pane that is 320px wide.
 *
 * Closing is safe rather than lossy: the composer forces a save on unmount, and
 * the Drafts view is where the message turns up again.
 *
 * This wrapper exists because the dialog registry carries only serialisable
 * entries — `sendAs` and the address book are fetched here rather than stuffed
 * into a Jotai atom.
 */
import { useEffect, useState } from 'react'
import { MailComposer } from './MailComposer'
import { trpc } from '../../lib/trpc'
import type { MailAddress } from '../../lib/mail-types'

export function ComposeMailDialog({
  draftId,
  onClose,
}: {
  draftId?: string
  onClose: () => void
}): React.JSX.Element {
  const [sendAs, setSendAs] = useState<string[]>([])
  const [contacts, setContacts] = useState<MailAddress[]>([])

  useEffect(() => {
    // Both are memoised per account in `googleData`, so opening this repeatedly
    // costs nothing. Neither failure is worth blocking the composer over.
    void trpc.google.sendAs
      .query()
      .then(setSendAs)
      .catch(() => setSendAs([]))
    void trpc.google.contacts
      .query()
      .then(setContacts)
      .catch(() => setContacts([]))
  }, [])

  return (
    <MailComposer
      intent={{ kind: 'new' }}
      draftId={draftId}
      sendAs={sendAs}
      suggestions={contacts}
      onSent={onClose}
      onDiscarded={onClose}
      onClose={onClose}
    />
  )
}
