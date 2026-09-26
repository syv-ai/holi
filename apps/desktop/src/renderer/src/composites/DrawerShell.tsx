/**
 * The one drawer every sidebar in Holi is: the nav on the left, history and the
 * last turn on the right. The PDF viewer's sidebars are the PDF library's own
 * DOM and cannot be this component, so they copy its width, motion, header and
 * edge through the stylesheet Holi injects (`lib/pdf-viewer-config.ts`).
 *
 * **It pushes.** A drawer slides its whole width in from the edge it docks on
 * and the content beside it moves over, then back out the same way: the
 * column's width runs 0 → w (`index.css`, `[data-slot='drawer']`), at the slide
 * pace, eased in and out and the same both ways. A transition rather than an
 * animation, so a press halfway through reverses it from where it is. The
 * content inside sits at the full width w, anchored to the far edge, so it
 * travels in whole rather than being squeezed.
 *
 * **It owns its column**, outside `react-resizable-panels`. The library has no
 * way to animate a panel's size, and a transition on its inline sizing would be
 * fighting it. So a drawer is a plain flex item with its own resize handle.
 *
 * **Resizing** is direct manipulation: the handle tracks the pointer 1:1 with
 * the transition off (D98), writes the width straight to the element while
 * dragging, and stores it once, on release, per drawer (`drawerWidthsAtom`).
 * Arrow keys move it by 16px for the keyboard. Every drawer shares one range
 * (`DRAWER_WIDTH`).
 *
 * **The edge** is `--drawer-edge`, a vault theme token, transparent by default:
 * a drawer lies flat on the page. The handle shows `--divider` under the
 * pointer, so the seam can be found without being drawn.
 */
import { useAtom } from 'jotai'
import { X } from 'lucide-react'
import { atomWithStorage } from 'jotai/utils'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { DRAWER_WIDTH, clampDrawerWidth } from '@/lib/drawer'
import { prefersReducedMotion } from '@/lib/motion'
import { PanelHeader, type HeaderAction } from './PanelHeader'

/** Each drawer's dragged width, by id. Account-wide rather than per vault: a
 *  sidebar's width is about the screen, not the notes. */
export const drawerWidthsAtom = atomWithStorage<Record<string, number>>('holi:drawerWidths', {})

const KEY_STEP = 16

export function DrawerShell({
  id,
  side,
  open,
  label,
  header,
  aside,
  actions,
  onClose,
  keepMounted = false,
  className,
  children,
}: {
  /** Which remembered width is this drawer's. */
  id: string
  /** The edge it docks on and slides from. */
  side: 'left' | 'right'
  open: boolean
  /** The drawer's accessible name, and its resize handle's. */
  label: string
  /** The header's leading region: a `DrawerTitle`, or a composition (the nav's
   *  vault picker). */
  header: React.ReactNode
  /** A dim fact at the header's right edge, before the actions. */
  aside?: React.ReactNode
  actions?: HeaderAction[]
  /** A close control at the end of the header. */
  onClose?: () => void
  /**
   * Keep the content mounted while closed (inert, width 0). The nav wants it:
   * its tree's expansion and scroll are state that closing should not throw
   * away. Other drawers unmount once they have slid out.
   */
  keepMounted?: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element | null {
  const [widths, setWidths] = useAtom(drawerWidthsAtom)
  const width = clampDrawerWidth(widths[id] ?? DRAWER_WIDTH.default)
  const ref = useRef<HTMLElement>(null)

  // Mounted while open, and for as long as the slide out takes.
  const [present, setPresent] = useState(open)
  useEffect(() => {
    if (open) setPresent(true)
    else if (prefersReducedMotion()) setPresent(false)
  }, [open])

  const [resizing, setResizing] = useState(false)

  if (!present && !keepMounted) return null

  const store = (px: number) => setWidths((prev) => ({ ...prev, [id]: clampDrawerWidth(px) }))
  // Dragging toward the content widens a drawer: rightward for the left one.
  const grow = side === 'left' ? 1 : -1

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (el === null || e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    let next = width
    setResizing(true)
    const move = (ev: PointerEvent) => {
      next = clampDrawerWidth(width + grow * (ev.clientX - startX))
      el.style.setProperty('--drawer-w', `${next}px`)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      setResizing(false)
      store(next)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (dir === 0) return
    e.preventDefault()
    store(width + grow * dir * KEY_STEP)
  }

  return (
    <section
      ref={ref}
      data-slot="drawer"
      data-drawer={id}
      data-side={side}
      data-state={open ? 'open' : 'closed'}
      // Slide in on mount, for a drawer that mounts BY opening. One that is
      // there from the start (the nav, at launch) just is.
      data-appear={keepMounted ? undefined : ''}
      data-resizing={resizing ? '' : undefined}
      aria-label={label}
      inert={!open}
      style={{ '--drawer-w': `${width}px` } as React.CSSProperties}
      className={cn(
        'relative flex h-full shrink-0 overflow-clip',
        side === 'left' ? 'justify-end' : 'justify-start',
        className,
      )}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === 'width' && !open) setPresent(false)
      }}
    >
      <div className="flex h-full w-(--drawer-w) shrink-0 flex-col">
        <PanelHeader
          actions={actions}
          close={onClose ? { icon: <X />, label: `Close ${label}`, onSelect: onClose } : undefined}
          className="border-drawer-edge"
        >
          {header}
          {aside !== undefined && (
            <span className="ml-auto shrink-0 text-muted-foreground">{aside}</span>
          )}
        </PanelHeader>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label}`}
        aria-valuemin={DRAWER_WIDTH.min}
        aria-valuemax={DRAWER_WIDTH.max}
        aria-valuenow={width}
        tabIndex={open ? 0 : -1}
        className={cn(
          // A 7px strip to catch the pointer, drawing a 1px line in its middle:
          // the theme's edge at rest, the divider while found or held.
          'absolute inset-y-0 z-10 w-[7px] cursor-col-resize outline-none',
          'after:absolute after:inset-y-0 after:left-[3px] after:w-px after:bg-drawer-edge',
          'after:motion-respond hover:after:bg-divider focus-visible:ring-1 focus-visible:ring-ring',
          resizing && 'after:bg-divider',
          side === 'left' ? '-right-[3px]' : '-left-[3px]',
        )}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
    </section>
  )
}

/** A drawer's title and a dim, truncating line of context after it (history's
 *  file path, the last turn's time). */
export function DrawerTitle({
  title,
  subtitle,
}: {
  title: string
  subtitle?: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <span className="font-medium text-foreground">{title}</span>
      {subtitle !== undefined && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{subtitle}</span>
      )}
    </>
  )
}
