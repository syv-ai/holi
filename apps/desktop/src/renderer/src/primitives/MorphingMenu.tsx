/**
 * A dock of icon shortcuts that morphs into the full, labelled list, with one
 * level of drill-down. A port of Danny Williams's morphing menu
 * (dannyjpwilliams.com/playground/morphing-menu), fitted to Holi: house tokens
 * instead of its inverted surface, the house `Tooltip` instead of its own hint
 * timer (the one Radix provider already gives the delay-then-instant session),
 * no links, and selection owned by the host.
 *
 * **The dock wraps.** Every item has a shortcut, in a grid as wide as the
 * menu's box allows: a sidebar wide enough holds one row, a narrower one
 * wraps. When a resize moves a shortcut to another cell it springs there
 * (`motion`'s layout animation) rather than jumping.
 *
 * **Vertical** is one column, for a rail too narrow for a row. It takes the
 * shortcuts that fit along its height, and only when some do not is there a
 * More: its list holds just those, so nothing is offered twice.
 *
 * **No surface at rest, unless asked.** The dock is bare icons on whatever it
 * sits on, or on the page's own background with `surface`, for a toolbar
 * that floats over rows. The popover surface and its shadow belong to the open
 * menu: they come with the open and fade back the moment the collapse starts,
 * not when it lands, so a finished interaction never lingers lighter.
 *
 * **One surface, pinned while open.** The shell is a single element that
 * resizes from the bar into a panel. Collapsed it sits in the menu's own box;
 * open it is `position: fixed` at the same corner, so it can grow out of a
 * clipping ancestor (a drawer, a 44px rail) over whatever is beside it, and
 * returns to its box once the collapse has landed.
 *
 * **Anchored at a corner.** By default the menu sits at the foot of what holds
 * it and opens upward from its bottom-left corner; `anchor="top-right"` puts
 * it at the top and opens it downward from that corner instead, as a toolbar
 * over a list does. When growing leftward from that corner would cross the
 * window's edge (the toolbar of a narrow sidebar), it grows rightward from the
 * dock's left edge instead.
 *
 * **A panel may rise.** Centred at the foot, a panel item marked `rise` grows
 * out of the dock and travels up to just under the middle of the view it
 * floats over (the nearest `[data-morph-stage]`, else the window): quick add,
 * a form worth writing in at eye level. The pin moves by its `bottom`, never
 * by a transform on an ancestor, which would carry the fixed pin with it.
 * Open, the shell follows its panel's size as the panel changes, so a rising
 * form that grows keeps its middle where it was.
 */
import { animate } from 'motion'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowLeft, ChevronRight, ChevronsUpDown } from 'lucide-react'
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/cn'
import { compress, PILL, rowAt, rowArrive, rowFrom, rowGone, rowLeave, spring } from './springs'
import { Icon, type IconGlyph } from './Icon'
import { IconButton } from './IconButton'

export type MorphingMenuAction = {
  id: string
  label: string
  icon: IconGlyph
  /** Shown in place of `icon` while this item is the active one. */
  activeIcon?: IconGlyph
  /** A count: on the icon's corner in the dock, at the row's end in the list.
   *  Nothing when absent or zero. */
  badge?: number
  /** `alert` paints the badge in the destructive colour: something is late. */
  badgeTone?: 'alert'
  /** A toggle's state: `aria-pressed`, and the accent background while on.
   *  Absent for an item that is not a toggle. */
  pressed?: boolean
  onSelect?: () => void
  /** A panel of its own instead of an action: selecting the item grows the
   *  menu into it, as a group grows into its rows. Given `close`, so a panel
   *  can fold the menu when its work is done, and whether it is the panel
   *  showing (it stays mounted while hidden). Elements marked
   *  `data-morph-row` cascade in. */
  panel?: (close: () => void, open: boolean) => ReactNode
  /** Centred anchor only: the open panel rises toward the middle of its view. */
  rise?: boolean
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
  /** The corner the menu grows from. `bottom-center` sits centred at the
   *  foot of its box and grows up and out from the middle, as a board's
   *  floating dock does. */
  anchor?: 'bottom-left' | 'top-right' | 'bottom-center'
  label: string
  moreLabel?: string
  backLabel?: string
  /** Rest on the page's background rather than bare, so rows under a floating
   *  toolbar do not show through it; `float` rests on the popover surface
   *  with its shadow, for a dock that floats over content (the board's). */
  surface?: boolean | 'float'
  className?: string
  /** For opening a panel item from outside (a hotkey). */
  ref?: React.Ref<MorphingMenuHandle>
}

export type MorphingMenuHandle = {
  /** Grow the menu into the panel of the item with this id. */
  openPanel: (id: string) => void
}

type View =
  | { kind: 'collapsed' }
  | { kind: 'main' }
  | { kind: 'group'; id: string }
  | { kind: 'panel'; id: string }

/** The geometry, in px: a shortcut, the bar's inset around them, and the pill
 *  they make. Numbers the fitting needs, so they live here and not in CSS. */
const BUTTON = 32
const INSET = 4
const THICKNESS = BUTTON + 2 * INSET

/** How a shortcut travels to its new cell when the dock re-wraps: sticky, a
 *  little past and back. */
const reflow = { type: 'spring', duration: 0.45, bounce: 0.35 } as const

/** How far the open menu keeps from the window's edge. */
const MARGIN = 8

/** How much of the way from the middle of its view back to the dock a rising
 *  panel stops: near the middle, not on it. */
const RISE_SHORT = 0.25

/**
 * A floating layer that belongs to something inside a morphing surface but
 * has to live outside it to show in full (quick add's completion list, which
 * the surface would clip). Marked with this attribute, a press in it counts as
 * inside: the menu and `MorphDialog` stay open.
 */
export const MORPH_OWNED = 'data-morph-owned'
export const isMorphOwned = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(`[${MORPH_OWNED}]`) !== null

/** How many of `total` shortcuts the vertical dock, which does not wrap, shows
 *  along a main axis `size` px long. All of them when they fit; otherwise one
 *  slot goes to More. */
export function dockCapacity(size: number, total: number): number {
  const slots = Math.max(0, Math.floor((size - 2 * INSET) / BUTTON))
  return total <= slots ? total : Math.max(0, slots - 1)
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
  anchor = 'bottom-left',
  label,
  moreLabel = 'More',
  backLabel = 'Back',
  surface = false,
  className,
  ref,
}: MorphingMenuProps): React.JSX.Element {
  const id = useId()
  const vertical = orientation === 'vertical'
  const top = anchor === 'top-right'
  const center = anchor === 'bottom-center'
  const tooltipSide = vertical ? 'right' : top ? 'bottom' : 'top'
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
  const barItems = vertical ? items.slice(0, dockCapacity(room, items.length)) : items
  /** What the dock had no room for: More's list, and More only when it has one. */
  const overflow = items.slice(barItems.length)
  const groups = items.filter((item) => item.children?.length)
  const panelItems = items.filter((item) => item.panel)
  const count = barItems.length + (overflow.length > 0 ? 1 : 0)
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
      groupFromDock.current = next.kind === 'group' || next.kind === 'panel'
    }
    focusNext.current = 'first'
    setView(next)
  }

  function close(restoreFocus = true, target = returnTarget.current) {
    focusNext.current = restoreFocus && openedWithKeyboard.current ? target : null
    setView({ kind: 'collapsed' })
  }

  useImperativeHandle(ref, () => ({
    // A hotkey is not a visit to the dock: closing leaves the focus off its
    // shortcut rather than drawing a ring on it.
    openPanel: (id: string) => open({ kind: 'panel', id }, id, false),
  }))

  function back() {
    if (view.kind === 'panel') {
      close(true, view.id)
      return
    }
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
    const box = root.getBoundingClientRect()
    /** The pin's `bottom` at the dock, and where a rising panel ends. */
    const rest = window.innerHeight - box.bottom
    const risingItem =
      center && view.kind === 'panel' && items.find((item) => item.id === view.id)?.rise
    const bottomFor = () => {
      if (!risingItem) return rest
      const stage = root.closest('[data-morph-stage]')?.getBoundingClientRect() ?? {
        top: 0,
        height: window.innerHeight,
      }
      const height = targetSize().height
      const middle = stage.top + stage.height / 2
      const atDock = box.bottom - height / 2
      const centre = middle + (atDock - middle) * RISE_SHORT
      return Math.max(
        rest,
        Math.min(window.innerHeight - centre - height / 2, window.innerHeight - height - MARGIN),
      )
    }
    const pin = () => {
      // Unmeasured (0) never flips: there is nothing yet to cross the edge.
      const width = targetSize().width
      const flip = top && width > 0 && box.right - width < MARGIN
      shell.toggleAttribute('data-flip', flip)
      Object.assign(
        shell.style,
        center
          ? {
              position: 'fixed',
              left: `${box.left + box.width / 2}px`,
              // A pin that is already up stays where it is; the rise moves it.
              ...(shell.dataset.pinned === undefined ? { bottom: `${rest}px` } : {}),
            }
          : flip
            ? {
                position: 'fixed',
                left: `${box.right - barSize.width}px`,
                right: 'auto',
                top: `${box.top}px`,
              }
            : top
              ? {
                  position: 'fixed',
                  left: '',
                  right: `${window.innerWidth - box.right}px`,
                  top: `${box.top}px`,
                }
              : {
                  position: 'fixed',
                  left: `${box.left}px`,
                  bottom: `${window.innerHeight - box.bottom}px`,
                },
        { zIndex: '50' },
      )
      shell.dataset.pinned = ''
    }
    // Raised only while pinned: collapsed, the shell must stay under whatever
    // covers its box, as the rail covers the hidden nav's dock. The surface is
    // not the pin's: it follows the open state (`data-open`).
    const unpin = () => {
      Object.assign(shell.style, {
        position: '',
        left: '',
        bottom: '',
        right: '',
        top: '',
        zIndex: '',
      })
      delete shell.dataset.pinned
      delete shell.dataset.flip
    }
    /** Landed open, the shell follows its panel as the panel changes size (a
     *  form that grows a field), a rising one about its middle. Not while it
     *  morphs: the spring owns the size until then. */
    let landed = false
    const follow = () => {
      if (!landed || cancelled || !panel) return
      const size = targetSize()
      Object.assign(shell.style, { width: `${size.width}px`, height: `${size.height}px` })
      if (center && shell.dataset.pinned !== undefined) shell.style.bottom = `${bottomFor()}px`
    }
    const observer = expanded && panel ? new ResizeObserver(follow) : null
    if (panel) observer?.observe(panel)
    const settle = () => {
      if (!expanded) unpin()
      landed = true
      follow()
    }
    const changed = old.kind !== view.kind || ('id' in old && 'id' in view && old.id !== view.id)
    const crossingBar = (old.kind === 'collapsed') !== (view.kind === 'collapsed')
    const snap = reducedMotion || !changed

    if (expanded) pin()
    // The centred pin travels between the dock and a rising panel's height;
    // a collapse brings it back to the dock before it unpins.
    if (center && shell.dataset.pinned !== undefined) {
      const bottom = `${bottomFor()}px`
      if (snap) shell.style.bottom = bottom
      else if (shell.style.bottom !== bottom)
        track(
          animate(
            shell,
            { bottom },
            // Rising, it leaves with the grow, not the squeeze.
            {
              ...spring,
              bounce: expanded ? 0.2 : 0.1,
              delay: expanded && crossingBar ? compress.duration : 0,
            },
          ),
        )
    }
    if (snap) {
      Object.assign(shell.style, {
        width: `${targetSize().width}px`,
        height: `${targetSize().height}px`,
      })
      settle()
    } else if (crossingBar) {
      const squeezed = vertical
        ? { width: PILL, height: Math.min(barSize.height, 200) }
        : { width: Math.min(barSize.width, 200), height: PILL }
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
      void track(animate(shell, targetSize(), { ...spring, duration: 0.25, bounce: 0.1 }))
        .finished.then(() => !cancelled && settle())
        .catch(() => {})
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
        const arriving = visible && crossingBar && !snap
        if (arriving) Object.assign(row.style, rowFrom)
        track(
          animate(
            row,
            visible || reducedMotion ? { ...rowAt, opacity: visible ? 1 : 0 } : rowGone,
            snap
              ? { ...spring, duration: 0 }
              : arriving
                ? rowArrive(index)
                : visible
                  ? { ...spring, duration: 0.25, bounce: 0, delay: index * 0.02 }
                  : rowLeave,
          ),
        )
      }
    }

    const destination = expanded ? panel : bar
    const controls = [...(destination?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])]
    const focus = focusNext.current
    focusNext.current = null
    if (focus) {
      const first =
        view.kind === 'panel'
          ? // The panel's first control, skipping pictures of controls
            // (`inert`) and anything the keyboard is not meant to land on.
            [
              ...(panel?.querySelectorAll<HTMLElement>(
                'input, textarea, button, [tabindex]:not([tabindex="-1"])',
              ) ?? []),
            ].find((element) => element.tabIndex >= 0 && !element.closest('[inert]'))
          : controls[0]
      const target =
        focus === 'first' ? first : controls.find((element) => element.dataset.menuItem === focus)
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
      observer?.disconnect()
      running.forEach((animation) => animation.stop())
      window.removeEventListener('resize', resize)
    }
    // `barSize` is derived from `count` and the grid; listing the object would
    // re-run every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, reducedMotion, items, count, grid.columns, vertical, top, center])

  useEffect(() => {
    if (!expanded) return
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target) &&
        !isMorphOwned(event.target)
      )
        close(false)
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
        <IconButton
          icon={active && item.activeIcon ? item.activeIcon : item.icon}
          label={item.label}
          size="md"
          shape="round"
          tooltipSide={tooltipSide}
          data-menu-item={item.id}
          aria-current={active ? (hasChildren ? 'true' : 'page') : undefined}
          pressed={item.pressed}
          active={active}
          aria-expanded={hasChildren ? false : undefined}
          aria-controls={hasChildren ? `${id}-group-${item.id}` : undefined}
          onClick={(event) =>
            hasChildren
              ? open({ kind: 'group', id: item.id }, item.id, event.detail === 0)
              : item.panel
                ? open({ kind: 'panel', id: item.id }, item.id, event.detail === 0)
                : select(item)
          }
        >
          {item.badge !== undefined && item.badge > 0 && (
            <span
              aria-hidden="true"
              data-tone={item.badgeTone}
              className={cn(
                'absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full px-1 text-[10px] leading-3.5',
                item.badgeTone === 'alert'
                  ? 'bg-destructive text-destructive-foreground'
                  : 'bg-foreground/15 text-foreground',
              )}
            >
              {item.badge}
            </span>
          )}
        </IconButton>
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
        aria-pressed={item.pressed}
        aria-expanded={hasChildren ? view.kind === 'group' && view.id === item.id : undefined}
        aria-controls={hasChildren ? `${id}-group-${item.id}` : undefined}
        className={cn(
          'flex min-h-8 w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm outline-none motion-respond hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring',
          (active || item.pressed) && 'bg-accent',
        )}
        onClick={(event) =>
          hasChildren
            ? open({ kind: 'group', id: item.id }, item.id, event.detail === 0)
            : item.panel
              ? open({ kind: 'panel', id: item.id }, item.id, event.detail === 0)
              : select(item)
        }
      >
        <Icon icon={active && item.activeIcon ? item.activeIcon : item.icon} />
        <span className="min-w-0 truncate">{item.label}</span>
        {item.badge !== undefined && item.badge > 0 && (
          <span
            data-tone={item.badgeTone}
            className={cn(
              'ml-auto shrink-0 text-xs',
              item.badgeTone === 'alert' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {item.badge}
          </span>
        )}
        {hasChildren && <Icon icon={ChevronRight} tone="muted" className="ml-auto" />}
      </button>
    )
  }

  const hiddenPanel = (hidden: boolean, width = 'w-67') =>
    cn(
      'absolute top-0 max-h-[calc(100dvh-4rem)] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain p-1.5',
      width,
      top ? FROM_RIGHT : center ? FROM_CENTER : 'left-0',
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
        if (view.kind === 'group' || view.kind === 'panel') back()
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
        className={cn(
          'group/morph absolute overflow-hidden rounded-[1.25rem]',
          top ? 'top-0 right-0' : center ? 'bottom-0 left-1/2 -translate-x-1/2' : 'bottom-0 left-0',
          'motion-respond text-muted-foreground',
          surface === 'float'
            ? 'bg-popover text-popover-foreground shadow-popover'
            : surface && 'bg-background',
          'data-open:bg-popover data-open:text-popover-foreground data-open:shadow-popover',
        )}
        data-open={expanded ? '' : undefined}
        style={barSize}
      >
        <div
          ref={barRef}
          aria-hidden={expanded}
          inert={expanded}
          className={cn(
            'absolute grid p-1',
            top ? `top-0 ${FROM_RIGHT}` : center ? `bottom-0 ${FROM_CENTER}` : 'bottom-0 left-0',
            expanded && 'pointer-events-none',
          )}
          style={{ ...barSize, gridTemplateColumns: `repeat(${grid.columns}, ${BUTTON}px)` }}
        >
          {barItems.map(shortcut)}
          {overflow.length > 0 && (
            <Cell still={reducedMotion}>
              <IconButton
                icon={ChevronsUpDown}
                label={moreLabel}
                size="md"
                shape="round"
                tooltipSide={tooltipSide}
                data-menu-item="more"
                aria-expanded={expanded}
                aria-controls={`${id}-main`}
                onClick={(event) => open({ kind: 'main' }, 'more', event.detail === 0)}
              />
            </Cell>
          )}
        </div>
        <div
          id={`${id}-main`}
          data-morph-panel=""
          aria-hidden={view.kind !== 'main'}
          inert={view.kind !== 'main'}
          className={hiddenPanel(view.kind !== 'main')}
        >
          {overflow.map(row)}
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
                <Icon icon={ArrowLeft} />
                <span>{backLabel}</span>
              </button>
              {group.children!.map(row)}
            </div>
          )
        })}
        {panelItems.map((item) => {
          const visible = view.kind === 'panel' && view.id === item.id
          return (
            <div
              key={item.id}
              data-morph-panel=""
              data-panel={item.id}
              aria-label={item.label}
              aria-hidden={!visible}
              inert={!visible}
              className={hiddenPanel(!visible, 'w-max')}
            >
              {item.panel!(() => close(), visible)}
            </div>
          )
        })}
      </div>
    </nav>
  )
}

/** The top-right anchor's inner layers hug the shell's right edge, or its left
 *  one while the open shell grows rightward (`data-flip`). */
const FROM_RIGHT = 'right-0 group-data-flip/morph:right-auto group-data-flip/morph:left-0'

/** The bottom-centre anchor's inner layers stay centred on the shell, which
 *  grows out from its middle. */
const FROM_CENTER = 'left-1/2 -translate-x-1/2'

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
