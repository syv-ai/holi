/** The sign-out question, which keeps a body of its own. */
import { useSetAtom } from 'jotai'
import { useEffect, useId, useState } from 'react'
import { ConfirmDialog } from '@/composites/confirm-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldLabel } from '@/components/ui/field'
import { trpc } from '@/lib/trpc'
import { signOutAtom } from '@/state/session'

export function SignOutConfirm({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const signOut = useSetAtom(signOutAtom)
  const [deleteClones, setDeleteClones] = useState(false)
  /** Vaults holding commits GitHub does not have yet, asked when it opens. */
  const [unpushed, setUnpushed] = useState<{ remote: string; ahead: number }[]>([])
  const id = useId()

  useEffect(() => {
    if (!open) return
    let live = true
    setDeleteClones(false)
    setUnpushed([])
    trpc.vaults.unpushed
      .query()
      .then((found) => live && setUnpushed(found.filter((v) => v.ahead > 0)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [open])

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Sign out?"
      description="Holi forgets your GitHub credential and stops syncing. Your vaults stay on this machine unless you choose otherwise."
      confirmLabel="Sign out"
      destructive
      onConfirm={() => void signOut({ deleteClones })}
    >
      <Field orientation="horizontal">
        <Checkbox
          id={id}
          checked={deleteClones}
          onCheckedChange={(next) => setDeleteClones(next === true)}
        />
        <FieldLabel htmlFor={id} className="font-normal">
          Also move the vaults on this machine to the Trash
        </FieldLabel>
      </Field>
      {unpushed.length > 0 ? (
        <p className="text-destructive text-sm">
          {unpushed
            .map(
              (v) =>
                `${v.remote} has ${v.ahead} ${v.ahead === 1 ? 'commit' : 'commits'} GitHub does not have yet`,
            )
            .join('; ')}
          .
        </p>
      ) : null}
    </ConfirmDialog>
  )
}
