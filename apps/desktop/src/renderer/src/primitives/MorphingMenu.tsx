/**
 * A dock of icon shortcuts that morphs into the full, labelled list, with one
 * level of drill-down. A port of Danny Williams's morphing menu
 * (dannyjpwilliams.com/playground/morphing-menu), fitted to Holi: house tokens
 * instead of its inverted surface, the house `Tooltip` instead of its own hint
 * timer (the one Radix provider already gives the delay-then-instant session),
 * no links, and selection owned by the host.
 *
 * **The dock wraps.** Every item has a shortcut, and More ends them, in a grid
 * as wide as the menu's box allows: a sidebar wide enough holds one row, a
 * narrower one wraps. When a resize moves a shortcut to another cell it
 * springs there (`motion`'s layout animation) rather than jumping. The
 * expanded list is where every item has its label.
 *
 * **Vertical** is one column, for a rail too narrow for a row. It takes the
 * shortcuts that fit along its height; the rest live in the list.
 *
 * **No surface at rest.** The dock is bare icons on whatever it sits on; the
 * popover surface and its shadow belong to the open menu, from the moment it
 * pins until its collapse lands.
 *
 * **One surface, pinned while open.** The shell is a single element that
 * resizes from the bar into a panel. Collapsed it sits in the menu's own box;
 * open it is `position: fixed` at the same corner, so it can grow out of a
 * clipping ancestor (a drawer, a 44px rail) over whatever is beside it, and
 * returns to its box once the collapse has landed.
 */
import { animate } from 'motion'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowLeft, ChevronRight, ChevronsUpDown } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Tooltip } from './Tooltip'

export type MorphingMenuAction = {
  id: string
  label: string
  icon: ReactNode
  /** Shown in place of `icon` while this item is the active one. */
  activeIcon?: ReactNode
  /** A count: on the icon's corner in the dock, at the row's end in the list.
   *  Nothing when absent or zero. */
  badge?: number
  onSelect?: () => void
}

/** One level of children keeps the menu small and the way back predictable. */
export type MorphingMenuItem = MorphingMenuAction & {
  children?: readonly MorphingMenuAction[]
}

export type MorphingMenuProps = {
  items: readonly MorphingMenuItem[]
  /** The active destination's id, or a child's: its parent reads as active too. */
  activeId?: string | null
  orientation?: 'horizontal' | 'vertical'
  label: string
  moreLabel?: string
  backLabel?: string
  className?: string
}

type View = { kind: 'collapsed' } | { kind: 'main' } | { kind: 'group'; id: string }

/** The geometry, in px: a shortcut, the bar's inset around them, and the pill
 *  they make. Numbers the fitting needs, so they live here and not in CSS. */
const BUTTON = 32
const INSET = 4
const THICKNESS = BUTTON + 2 * INSET

// The morph's character: tune here. A spring is physics rather than one of the
// vocabulary's durations, so these are the component's own.
const spring = { type: 'spring', duration: 0.4, bounce: 0.24 } as const
const compress = { duration: 0.1, ease: [0.4, 0, 0.2, 1] } as const

/** How a shortcut travels to its new cell when the dock re-wraps: sticky, a
 *  little past and back. */
const reflow = { type: 'spring', duration: 0.45, bounce: 0.35 } as const

/** How many shortcuts fit before More, along a main axis `size` px long: the
 *  vertical dock, which does not wrap. */
export function dockCapacity(size: number): number {
  return Math.max(0, Math.floor((size - 2 * INSET) / BUTTON) - 1)
}

/** The horizontal dock's grid for `cells` shortcuts (More included) in a
 *  `room` px wide box: rows filled to the width, the last one holding the
 *  rest. Unmeasured (`room` 0) is taken as wide enough for one row. */
export function dockGrid(cells: number, room: number): { columns: number; rows: number } {
  const fit = room > 0 ? Math.max(1, Math.floor((room - 2 * INSET) / BUTTON)) : cells
  const columns = Math.max(1, Math.min(cells, fit))
  return { columns, rows: Math.ceil(cells / columns) }
}

export function MorphingMenu({
  items,
  activeId = null,
  orientation = 'horizontal',
  label,
  moreLabel = 'More',
  backLabel = 'Back',
  className,
}: MorphingMenuProps): React.JSX.Element {
  const id = useId()
  const vertical = orientation === 'vertical'
  const [view, setView] = useState<View>({ kind: 'collapsed' })
  const [room, setRoom] = useState(0)
  const rootRef = useRef<HTMLElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const previousView = useRef<View>(view)
  const returnTarget = useRef('more')
  /** A group opened straight from its dock shortcut: Back closes the menu
   *  rather than showing a list that was never open. */
  const groupFromDock = useRef(false)
  const openedWithKeyboard = useRef(false)
  const focusNext = useRef<string | null>(null)
  const reducedMotion = useReducedMotion() ?? false
  const expanded = view.kind !== 'collapsed'
  const barItems = vertical ? items.slice(0, dockCapacity(room)) : items
  const groups = items.filter((item) => item.children?.length)
  const count = barItems.length + 1
  const grid = vertical ? { columns: 1, rows: count } : dockGrid(count, room)
  const barSize = {
    width: grid.columns * BUTTON + 2 * INSET,
    height: grid.rows * BUTTON + 2 * INSET,
  }

  // The room along the main axis is what decides the dock, so it is watched.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => setRoom(vertical ? root.clientHeight : root.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [vertical])

  function open(next: View, origin: string, keyboard: boolean) {
    if (!expanded) {
      returnTarget.current = origin
      openedWithKeyboard.current = keyboard
      groupFromDock.current = next.kind === 'group'
    }
    focusNext.current = 'first'
    setView(next)
  }

  function close(restoreFocus = true, target = returnTarget.current) {
    focusNext.current = restoreFocus && openedWithKeyboard.current ? target : null
    setView({ kind: 'collapsed' })
  }

  function back() {
    if (view.kind !== 'group') return
    if (groupFromDock.current) {
      close(true, view.id)
      return
    }
    focusNext.current = view.id
    setView({ kind: 'main' })
  }

  function select(item: MorphingMenuAction) {
    if (expanded) close(true, view.kind === 'group' ? view.id : item.id)
    item.onSelect?.()
  }

  // The shell stays mounted. Interrupting an animation cancels its next phase,
  // then the next transition starts from the currently rendered geometry.
  useLayoutEffect(() => {
    const root = rootRef.current
    const shell = shellRef.current
    const bar = barRef.current
    if (!root || !shell || !bar) return
    const old = previousView.current
    previousView.current = view
    const panels = [...root.querySelectorAll<HTMLElement>('[data-morph-panel]')]
    const panel = panels.find((element) => element.getAttribute('aria-hidden') === 'false')
    const running: ReturnType<typeof animate>[] = []
    let cancelled = false
    const track = (animation: ReturnType<typeof animate>) => {
      running.push(animation)
      return animation
    }
    const targetSize = () => ({
      width: panel?.offsetWidth ?? barSize.width,
      height: panel?.offsetHeight ?? barSize.height,
    })
    const pin = () => {
      const box = root.getBoundingClientRect()
      Object.assign(shell.style, {
        position: 'fixed',
        left: `${box.left}px`,
        bottom: `${window.innerHeight - box.bottom}px`,
        zIndex: '50',
      })
      shell.dataset.pinned = ''
    }
    // Raised only while pinned: collapsed, the shell must stay under whatever
    // covers its box, as the rail covers the hidden nav's dock. The surface
    // goes with it (`data-pinned`), so the dock at rest is bare.
    const unpin = () => {
      Object.assign(shell.style, { position: '', left: '', bottom: '', zIndex: '' })
      delete shell.dataset.pinned
    }
    const settle = () => {
      if (!expanded) unpin()
    }
    const changed =
      old.kind !== view.kind ||
      (old.kind === 'group' && view.kind === 'group' && old.id !== view.id)
    const crossingBar = (old.kind === 'collapsed') !== (view.kind === 'collapsed')
    const snap = reducedMotion || !changed

    if (expanded) pin()
    if (snap) {
      Object.assign(shell.style, {
        width: `${targetSize().width}px`,
        height: `${targetSize().height}px`,
      })
      settle()
    } else if (crossingBar) {
      const squeezed = vertical
        ? { width: 28, height: Math.min(barSize.height, 200) }
        : { width: Math.min(barSize.width, 200), height: 28 }
      const compression = track(animate(shell, squeezed, compress))
      void compression.finished
        .then(() => {
          if (cancelled) return
          const grow = track(
            animate(shell, targetSize(), { ...spring, bounce: expanded ? 0.24 : 0.15 }),
          )
          void grow.finished.then(() => !cancelled && settle()).catch(() => {})
        })
        .catch(() => {}) // A stopped transition must never resume its second phase.
    } else {
      track(animate(shell, targetSize(), { ...spring, duration: 0.25, bounce: 0.1 }))
    }

    track(
      animate(
        bar,
        {
          opacity: expanded ? 0 : 1,
          scale: expanded && !reducedMotion ? 0.8 : 1,
          filter: expanded && !reducedMotion ? 'blur(8px)' : 'blur(0px)',
        },
        {
          duration: snap ? 0 : expanded ? 0.15 : 0.22,
          delay: !snap && !expanded ? 0.08 : 0,
          ...(!expanded ? { ease: 'easeOut' as const } : {}),
        },
      ),
    )

    for (const layer of panels) {
      const visible = layer === panel
      for (const [index, row] of [
        ...layer.querySelectorAll<HTMLElement>('[data-morph-row]'),
      ].entries()) {
        if (visible && crossingBar && !snap) {
          Object.assign(row.style, {
            opacity: '0',
            transform: 'translateY(48px)',
            filter: 'blur(4px)',
          })
        }
        track(
          animate(
            row,
            {
              opacity: visible ? 1 : 0,
              y: visible || reducedMotion ? 0 : 16,
              filter: visible || reducedMotion ? 'blur(0px)' : 'blur(2px)',
            },
            {
              ...spring,
              duration: snap ? 0 : visible ? (crossingBar ? 0.4 : 0.25) : 0.12,
              bounce: crossingBar ? 0.3 : 0,
              delay: !snap && visible ? (crossingBar ? 0.2 : 0) + index * 0.02 : 0,
            },
          ),
        )
      }
    }

    const destination = expanded ? panel : bar
    const controls = [...(destination?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])]
    const focus = focusNext.current
    focusNext.current = null
    if (focus) {
      const target =
        focus === 'first'
          ? controls[0]
          : controls.find((element) => element.dataset.menuItem === focus)
      // An item the dock had no room for has no shortcut to return to.
      ;(
        target ??
        (!expanded ? controls.find((element) => element.dataset.menuItem === 'more') : undefined)
      )?.focus({ preventScroll: true })
    }

    // A window resize moves the corner the open shell is pinned to.
    const resize = () => setView((current) => ({ ...current }))
    window.addEventListener('resize', resize)
    return () => {
      cancelled = true
      running.forEach((animation) => animation.stop())
      window.removeEventListener('resize', resize)
    }
    // `barSize` is derived from `count` and the grid; listing the object would
    // re-run every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, reducedMotion, items, count, grid.columns, vertical])

  useEffect(() => {
    if (!expanded) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [expanded])

  const isActive = (item: MorphingMenuItem) =>
    activeId === item.id || Boolean(item.children?.some((child) => child.id === activeId))

  function shortcut(item: MorphingMenuItem) {
    const hasChildren = Boolean(item.children?.length)
    const active = isActive(item)
    return (
      <Cell key={item.id} still={reducedMotion}>
        <Tooltip content={item.label} side={vertical ? 'right' : 'top'}>
          <button
            type="button"
            data-menu-item={item.id}
            aria-label={item.label}
            aria-current={active ? (hasChildren ? 'true' : 'page') : undefined}
            aria-expanded={hasChildren ? false : undefined}
            aria-controls={hasChildren ? `${id}-group-${item.id}` : undefined}
            className={cn(
              'relative flex size-8 shrink-0 items-center justify-center rounded-full outline-none motion-respond hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
              active && 'bg-accent text-foreground',
            )}
            onClick={(event) =>
              hasChildren
                ? open({ kind: 'group', id: item.id }, item.id, event.detail === 0)
                : select(item)
            }
          >
            <span className="flex" aria-hidden="true">
              {active && item.activeIcon ? item.activeIcon : item.icon}
            </span>
            {item.badge !== undefined && item.badge > 0 && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-foreground/15 px-1 text-[10px] leading-3.5 text-foreground"
              >
                {item.badge}
              </span>
            )}
          </button>
        </Tooltip>
      </Cell>
    )
  }

  function row(item: MorphingMenuItem) {
    const hasChildren = Boolean(item.children?.length)
    const active = isActive(item)
    return (
      <button
        key={item.id}
        type="button"
        data-morph-row=""
        data-menu-item={item.id}
        aria-current={active ? (hasChildren ? 'true' : 'page') : undefined}
        aria-expanded={hasChildren ? view.kind === 'group' && view.id === item.id : undefined}
        aria-controls={hasChildren ? `${id}-group-${item.id}` : undefined}
        className={cn(
          'flex min-h-8 w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm outline-none motion-respond hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring',
          active && 'bg-accent',
        )}
        onClick={(event) =>
          hasChildren
            ? open({ kind: 'group', id: item.id }, item.id, event.detail === 0)
            : select(item)
        }
      >
        <span className="flex shrink-0" aria-hidden="true">
          {active && item.activeIcon ? item.activeIcon : item.icon}
        </span>
        <span className="min-w-0 truncate">{item.label}</span>
        {item.badge !== undefined && item.badge > 0 && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{item.badge}</span>
        )}
        {hasChildren && (
          <ChevronRight size={16} aria-hidden="true" className="ml-auto shrink-0 opacity-60" />
        )}
      </button>
    )
  }

  const hiddenPanel = (hidden: boolean) =>
    cn(
      'absolute top-0 left-0 max-h-[calc(100dvh-4rem)] w-67 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain p-1.5',
      hidden && 'pointer-events-none',
    )

  return (
    <nav
      ref={rootRef}
      aria-label={label}
      data-view={view.kind}
      data-orientation={orientation}
      className={cn('relative shrink-0', vertical ? 'min-h-0 w-10 flex-1' : 'w-full', className)}
      // A wrapped dock is as tall as its rows.
      style={vertical ? undefined : { height: barSize.height }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !expanded) return
        event.preventDefault()
        event.stopPropagation()
        if (view.kind === 'group') back()
        else close()
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return
        if (expanded && event.relatedTarget instanceof Node) close(false)
      }}
    >
      <div
        ref={shellRef}
        className="absolute bottom-0 left-0 overflow-hidden rounded-[1.25rem] text-muted-foreground data-pinned:bg-popover data-pinned:text-popover-foreground data-pinned:shadow-popover"
        style={barSize}
      >
        <div
          ref={barRef}
          aria-hidden={expanded}
          inert={expanded}
          className={cn('absolute bottom-0 left-0 grid p-1', expanded && 'pointer-events-none')}
          style={{ ...barSize, gridTemplateColumns: `repeat(${grid.columns}, ${BUTTON}px)` }}
        >
          {barItems.map(shortcut)}
          <Cell still={reducedMotion}>
            <Tooltip content={moreLabel} side={vertical ? 'right' : 'top'}>
              <button
                type="button"
                data-menu-item="more"
                aria-label={moreLabel}
                aria-expanded={expanded}
                aria-controls={`${id}-main`}
                className="flex size-8 shrink-0 items-center justify-center rounded-full outline-none motion-respond hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                onClick={(event) => open({ kind: 'main' }, 'more', event.detail === 0)}
              >
                <ChevronsUpDown size={16} aria-hidden="true" />
              </button>
            </Tooltip>
          </Cell>
        </div>
        <div
          id={`${id}-main`}
          data-morph-panel=""
          aria-hidden={view.kind !== 'main'}
          inert={view.kind !== 'main'}
          className={hiddenPanel(view.kind !== 'main')}
        >
          {items.map(row)}
        </div>
        {groups.map((group) => {
          const visible = view.kind === 'group' && view.id === group.id
          return (
            <div
              key={group.id}
              id={`${id}-group-${group.id}`}
              data-morph-panel=""
              aria-label={group.label}
              aria-hidden={!visible}
              inert={!visible}
              className={hiddenPanel(!visible)}
            >
              <button
                type="button"
                data-morph-row=""
                data-menu-item="back"
                className="flex min-h-8 w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm text-muted-foreground outline-none motion-respond hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
                onClick={back}
              >
                <ArrowLeft size={16} aria-hidden="true" />
                <span>{backLabel}</span>
              </button>
              {group.children!.map(row)}
            </div>
          )
        })}
      </div>
    </nav>
  )
}

/**
 * One grid cell of the dock. The layout spring lives here rather than on the
 * button because the button's `motion-respond` transitions `transform`, which
 * would drag behind every frame the spring writes.
 */
function Cell({ still, children }: { still: boolean; children: ReactNode }) {
  return (
    <motion.div layout={!still} transition={reflow} className="flex size-8">
      {children}
    </motion.div>
  )
}
