import { useState, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Spinner } from '@/components/ui/spinner'

/**
 * The one "are you sure?" in the app: delete, leave a vault, sign out, discard.
 * A stock AlertDialog with a title, an optional line of consequence, Cancel and
 * one confirming action. `destructive` paints the action as a destructive
 * Button. Controlled: the caller owns `open`.
 *
 * `onConfirm` may return a Promise. While it is pending the action shows a
 * spinner and both buttons are disabled; if it rejects the dialog stays open
 * and shows the error under the description; on success it closes.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  size,
  children,
  onCloseAutoFocus,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** What happens if they confirm, in one sentence. */
  description?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  size?: 'default' | 'sm'
  /** Under the sentence: a choice that goes with the answer, a warning. */
  children?: ReactNode
  /** Where focus goes when it closes, for a caller whose trigger has gone. */
  onCloseAutoFocus?: (event: Event) => void
  onConfirm: () => void | Promise<unknown>
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const change = (next: boolean): void => {
    if (pending) return
    if (!next) setError(null)
    onOpenChange(next)
  }

  const confirm = (event: React.MouseEvent): void => {
    const result = onConfirm()
    if (!(result instanceof Promise)) return
    // Hold the dialog open until the work settles.
    event.preventDefault()
    setPending(true)
    setError(null)
    result.then(
      () => {
        setPending(false)
        onOpenChange(false)
      },
      (err: unknown) => {
        setPending(false)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogContent size={size} onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description !== undefined && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={confirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
