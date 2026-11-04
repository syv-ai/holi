/**
 * The one mount for dialogs asked for through the registry (`state/dialogs.ts`):
 * a plugin's dialog, drawn in the stock `Dialog` at the width it asked for.
 * The plugin draws everything inside, its title and footer included.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { closeDialogAtom, shownDialogAtom, type DialogSize } from '@/state/dialogs'

/** Each size's width; `bare` draws its own edges at the stock width. */
const WIDTH = {
  sm: 'md',
  md: 'lg',
  lg: '3xl',
  full: '6xl',
  bare: 'default',
} as const satisfies Record<DialogSize, string>

export function DialogHost(): React.JSX.Element | null {
  const dialog = useAtomValue(shownDialogAtom)
  const close = useSetAtom(closeDialogAtom)
  if (dialog?.id !== 'plugin') return null
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        variant={dialog.size === 'bare' ? 'flush' : 'default'}
        showCloseButton={dialog.closable !== false}
        size={WIDTH[dialog.size]}
        aria-describedby={undefined}
      >
        {dialog.render(() => close())}
      </DialogContent>
    </Dialog>
  )
}
