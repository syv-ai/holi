/**
 * Approving a Holi on this machine, before its first send and after any
 * change to what it does (docs/features/holis.md): the dialog shows exactly
 * what the approval covers, its soul, model, the documents it takes and what
 * it may do without asking, and confirming approves that text (and sends, when
 * a send asked). Nobody approves text behind a link.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useState } from 'react'
import { approvePendingAtom, pendingApprovalAtom } from './state'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

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
  const approve = useSetAtom(approvePendingAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (pending === null) return null
  const { holi, path } = pending
  const accepts = holi.accepts ?? []
  const allow = holi.allow ?? []

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (next) return
        setError(null)
        close(null)
      }}
    >
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {holi.status === 'changed'
              ? `${holi.name} has changed`
              : `Run ${holi.name} on this machine?`}
          </DialogTitle>
        </DialogHeader>
        <div>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {holi.status === 'changed'
                ? 'What it does changed since you approved it here, by a pull or by an edit. Read it again.'
                : 'It is a file in the vault, which anyone who can push can change. Approving runs what it says now; a change asks again.'}{' '}
              {path === undefined ? (
                'It asks you before anything its rules do not allow.'
              ) : (
                <>
                  It starts on <code className="font-mono text-xs">{path}</code>, in the Agents
                  view, and asks you before anything its rules do not allow.
                </>
              )}{' '}
              Its memory is notes its runs keep, and is not part of what you approve.
            </p>
            <Part label="Soul">
              <p className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl bg-foreground/[0.04] p-2.5 text-sm leading-relaxed">
                {holi.soul === undefined || holi.soul === '' ? 'Empty.' : holi.soul}
              </p>
            </Part>
            <Part label="Allowed without asking">
              {allow.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing: it asks before each action.
                </p>
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
        </div>
        <DialogFooter>
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
            {path === undefined ? 'Approve' : 'Approve and send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
