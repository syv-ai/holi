import * as RadixDialog from '@radix-ui/react-dialog'
import { cn } from '@/lib/cn'

/**
 * The dialog shell. Overlay + focus-trap + portal + Escape/backdrop-close come
 * from Radix; `size` is a guarded union (Replace Primitive with Object), not a
 * free-form string. Feature dialogs stop existing: a content block fills the
 * Header/Body/Footer slots and a registry entry supplies the size.
 */
export type DialogSize = 'sm' | 'md' | 'lg'

const panel: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
}

type DialogProps = {
  open: boolean
  onClose: () => void
  size?: DialogSize
  children: React.ReactNode
}

export function Dialog({ open, onClose, size = 'md', children }: DialogProps): React.JSX.Element {
  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <RadixDialog.Content
          // We label via Dialog.Header (Radix Title); opt out of the description requirement.
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2',
            'max-h-[85vh] overflow-y-auto rounded-control border border-border bg-surface p-4',
            'text-sm text-foreground shadow-xl outline-none',
            panel[size],
          )}
        >
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

Dialog.Header = function DialogHeader({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <RadixDialog.Title className="mb-3 text-sm font-medium text-foreground">{children}</RadixDialog.Title>
}

Dialog.Body = function DialogBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-3">{children}</div>
}

Dialog.Footer = function DialogFooter({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <div className="mt-4 flex items-center justify-end gap-2">{children}</div>
}
