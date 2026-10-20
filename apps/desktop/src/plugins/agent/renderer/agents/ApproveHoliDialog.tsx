/**
 * Approving a Holi on this machine, before its first send and after any
 * change to what it does (docs/features/holis.md): the dialog shows exactly
 * what the approval covers, its instructions, model, the documents it takes
 * and what it may do without asking, and confirming approves that text and
 * sends. Nobody approves text behind a link.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useState } from 'react'
import { Badge, Button, Dialog } from '@/primitives'
import { approveAndSendAtom, pendingApprovalAtom } from '../state/holis'

function Part({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

export function ApproveHoliDialog(): React.JSX.Element | null {
  const pending = useAtomValue(pendingApprovalAtom)
  const close = useSetAtom(pendingApprovalAtom)
  const approve = useSetAtom(approveAndSendAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (pending === null) return null
  const { holi, path } = pending
  const accepts = holi.accepts ?? []
  const allow = holi.allow ?? []

  return (
    <Dialog
      open
      onClose={() => {
        setError(null)
        close(null)
      }}
      size="md"
    >
      <Dialog.Header>
        {holi.status === 'changed'
          ? `${holi.name} has changed`
          : `Run ${holi.name} on this machine?`}
      </Dialog.Header>
      <Dialog.Body>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {holi.status === 'changed'
              ? 'What it does changed since you approved it here, by a pull or by an edit. Read it again.'
              : 'It is a file in the vault, which anyone who can push can change. Approving runs what it says now; a change asks again.'}{' '}
            It starts on <code className="font-mono text-xs">{path}</code>, in an agent tab, and
            asks you before anything its rules do not allow.
          </p>
          <Part label="Instructions">
            <p className="whitespace-pre-wrap rounded-xl bg-foreground/[0.04] p-2.5 text-sm leading-relaxed">
              {holi.instructions}
            </p>
          </Part>
          <Part label="Allowed without asking">
            {allow.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing: it asks before each action.</p>
            ) : (
              <p className="rounded-xl bg-foreground/[0.04] p-2.5 font-mono text-xs leading-relaxed">
                {allow.map((r) => (
                  <span key={r} className="block">
                    {r}
                  </span>
                ))}
              </p>
            )}
          </Part>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">Model: {holi.model ?? 'default'}</Badge>
            <Badge variant="outline">
              Takes: {accepts.length === 0 ? 'any document' : accepts.join(', ')}
            </Badge>
          </div>
          {error !== null && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" size="sm" onClick={() => close(null)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setError(null)
            void approve().then((res) => {
              setBusy(false)
              if (!res.ok) setError(res.message)
            })
          }}
        >
          Approve and send
        </Button>
      </Dialog.Footer>
    </Dialog>
  )
}
