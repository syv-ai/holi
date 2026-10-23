import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { MailComposer } from "../MailComposer"
import type { MailAddress } from "./use-mail"

export interface ComposeRequest {
  /** The Gmail draft to continue, or none for a new message. */
  draftId?: string
  /** A fresh composer per request: it reads its draft once, on mount. */
  key: number
}

/**
 * A new message, or a draft continued, in a dialog: neither has a thread to
 * keep in view. The composer is `MailComposer`, the one Holi already has:
 * closing is safe because it saves on unmount, and the draft waits in Drafts.
 */
export function ComposeDialog({
  request,
  sendAs,
  contacts,
  onReconnect,
  onClose,
}: {
  request: ComposeRequest | null
  sendAs: string[]
  contacts: MailAddress[]
  onReconnect: () => void
  onClose: () => void
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {request?.draftId === undefined ? "New message" : "Draft"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Write in markdown; it is sent as the preview shows it.
          </DialogDescription>
        </DialogHeader>
        {request !== null && (
          <MailComposer
            key={request.key}
            intent={{ kind: "new" }}
            draftId={request.draftId}
            sendAs={sendAs}
            suggestions={contacts}
            onSent={onClose}
            onDiscarded={onClose}
            onClose={onClose}
            onReconnect={onReconnect}
            bare
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
