/**
 * A brand-new message, as a dialog.
 *
 * A reply mounts inline under the thread it answers; a fresh message has no
 * context to preserve, so a modal costs nothing. Closing is safe: the composer
 * forces a save on unmount, and the Drafts view finds it again.
 *
 * This wrapper exists because the dialog registry carries only serialisable
 * entries, so `sendAs` and the address book are fetched here.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import { MailComposer } from './MailComposer'
import { googleCap } from '../../state/google'
import { activeRemoteAtom } from '../../state/vaults'
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
  const remote = useAtomValue(activeRemoteAtom)

  useEffect(() => {
    // Both are memoised per account in `googleData`, so opening this repeatedly
    // costs nothing. Neither failure is worth blocking the composer over.
    if (remote === null) return
    void googleCap
      .sendAs(remote)
      .then(setSendAs)
      .catch(() => setSendAs([]))
    void googleCap
      .contacts(remote)
      .then(setContacts)
      .catch(() => setContacts([]))
  }, [remote])

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
