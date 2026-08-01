import { Drawer as DrawerPrimitive } from 'vaul'
import { cn } from '@/lib/cn'

/**
 * The drawer shell — a draggable side panel (shadcn's Drawer, on `vaul`). Parallel
 * to our `Dialog` wrapper: an opinionated `open`/`onClose`/`side` API plus
 * Header/Title/Body/Footer slots, rather than shadcn's compound export set.
 * Defaults to `side="right"` and `modal={false}` so the surface behind stays
 * interactive (these replace inline side-columns, not modal dialogs). Width is the
 * caller's — pass it via `className` (e.g. `w-80`). Draggable-to-dismiss + Escape
 * both resolve to `onClose` via vaul's `onOpenChange`.
 */
export type DrawerSide = 'left' | 'right'

type DrawerProps = {
  open: boolean
  onClose: () => void
  side?: DrawerSide
  modal?: boolean
  className?: string
  children: React.ReactNode
}

export function Drawer({
  open,
  onClose,
  side = 'right',
  modal = false,
  className,
  children,
}: DrawerProps): React.JSX.Element {
  return (
    <DrawerPrimitive.Root
      open={open}
      direction={side}
      modal={modal}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DrawerPrimitive.Portal>
        {modal && <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />}
        <DrawerPrimitive.Content
          // Titled via Drawer.Title; opt out of Radix's description requirement.
          aria-describedby={undefined}
          className={cn(
            'fixed inset-y-0 z-50 flex h-full flex-col bg-background text-sm text-foreground outline-none',
            side === 'right' ? 'right-0 border-l border-border' : 'left-0 border-r border-border',
            className,
          )}
        >
          {children}
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  )
}

Drawer.Header = function DrawerHeader({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-2 border-b border-border px-3 py-2', className)}>
      {children}
    </div>
  )
}

Drawer.Title = function DrawerTitle({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <DrawerPrimitive.Title className={cn('text-sm font-medium text-foreground', className)}>
      {children}
    </DrawerPrimitive.Title>
  )
}

Drawer.Body = function DrawerBody({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto', className)}>{children}</div>
}

Drawer.Footer = function DrawerFooter({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return <div className={cn('mt-auto border-t border-border p-2', className)}>{children}</div>
}
