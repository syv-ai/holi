import { XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { cn } from '@/lib/cn'

/**
 * The dialog shell. Overlay + focus-trap + portal + Escape/backdrop-close come
 * from Radix (shadcn's dialog primitive); `size` is a guarded union (Replace
 * Primitive with Object), not a free-form string. Feature dialogs stop existing:
 * a content block fills the Header/Body/Footer slots and a registry entry supplies
 * the size. We keep this opinionated `open`/`onClose`/`size` wrapper rather than
 * shadcn's compound API — the block + registry pattern is the grilled house shape;
 * the styling below is shadcn's (animations, close button, tokens).
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
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/50',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
          )}
        />
        <DialogPrimitive.Content
          // We label via Dialog.Header (Radix Title); opt out of the description requirement.
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4',
            'max-h-[85vh] overflow-y-auto rounded-lg border bg-background p-6',
            'text-sm text-foreground shadow-lg outline-none duration-200',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
            'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
            panel[size],
          )}
        >
          {children}
          <DialogPrimitive.Close
            className={cn(
              'absolute right-4 top-4 rounded-xs opacity-70 transition-opacity',
              'hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              'disabled:pointer-events-none',
            )}
          >
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

Dialog.Header = function DialogHeader({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <DialogPrimitive.Title className="text-sm font-medium text-foreground">
      {children}
    </DialogPrimitive.Title>
  )
}

Dialog.Body = function DialogBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-3">{children}</div>
}

Dialog.Footer = function DialogFooter({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <div className="flex items-center justify-end gap-2">{children}</div>
}
