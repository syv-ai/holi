// The question leaving the open vault asks while something running in it would
// be lost: each running plugin's `leaveGuard` sentence, such as the agent's
// busy sessions. Adding a vault asks it up front, since adding opens the new one.
import { useState } from "react"
import { useAtomValue } from "jotai"

import { ConfirmDialog } from "@/composites/confirm-dialog"
import { leaveReasonsAtom } from "@/state/plugins"

const WORDING = {
  switch: { title: "Switch vaults?", lead: "", go: "Switch anyway" },
  add: {
    title: "Add a vault?",
    lead: "Adding a vault opens it, and leaves this one.",
    go: "Continue",
  },
}

export function LeaveVaultDialog({
  intent,
  onConfirm,
  onCancel,
}: {
  intent: keyof typeof WORDING
  onConfirm: () => void
  onCancel: () => void
}) {
  const wording = WORDING[intent]
  // Read once: a turn landing while the dialog is open would otherwise
  // rewrite the sentence under the reader.
  const all = useAtomValue(leaveReasonsAtom)
  const [said] = useState(all)

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onCancel()}
      size="sm"
      title={wording.title}
      description={[wording.lead, ...said].filter((s) => s !== "").join(" ")}
      confirmLabel={wording.go}
      destructive
      onConfirm={onConfirm}
    />
  )
}
