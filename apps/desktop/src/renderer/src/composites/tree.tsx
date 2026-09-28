/**
 * The tree's look, one system for every tree in the app: the vault explorer
 * (docs/features/file-tree.md), the settings rail and the history.
 *
 * - **Roots are headings**: 15px, dim until they are the one in use, and the
 *   one in use is marked by a brand bar at their left that slides between
 *   them (`TreeBar`).
 * - **A group hangs from its opener** on a rounded connector (`TreeBranch`):
 *   a rail down the left, an elbow into each row, and the way to the current
 *   row drawn in the brand colour.
 * - **A group opens by sliding** its rows' track from nothing (`TreeDisclose`,
 *   whose motion is `[data-slot='disclose']` in `index.css`).
 *
 * Geometry lives here because the connector's path and the rows it meets must
 * agree to the pixel. What a row does (click, keys, drag, menus) is each
 * tree's own business; this is look only.
 */
import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { cn } from '@/lib/cn'

/** A nested row's height, which the connector's elbow is drawn to. */
export const TREE_ROW = 22
const MID = TREE_ROW / 2
const RADIUS = 6
/** The elbow's run from the rail to where the row's lead starts. */
export const TREE_ELBOW = 20
/** Where a root's group hangs: under the centre of its heading's lead. */
export const TREE_ROOT_HANG = 31
/** Where a nested group hangs: under the centre of its row's lead. */
export const TREE_NESTED_HANG = 7

/**
 * A tree row is a Button with none of a button's chrome: no fill, no press.
 * Block-level `flex`, not the Button's `inline-flex`: an inline row sits on a
 * line box, whose baseline strut adds a few pixels under a row with no glyph.
 */
export const TREE_ROW_RESET =
  'flex h-auto w-full justify-start rounded-none px-0 font-normal active:scale-100 hover:bg-transparent dark:hover:bg-transparent'

/**
 * A row's name, boxed from its x-height to its baseline (`text-box`), so the
 * row's centring puts the lead on the middle of the letters rather than of
 * the line, which sits a couple of pixels higher. It clips sideways only: a
 * vertical clip would cut the ascenders the trim leaves outside the box.
 */
export const TREE_LABEL =
  'min-w-0 overflow-x-clip text-ellipsis whitespace-nowrap [text-box:trim-both_ex_alphabetic]'

/** A root heading's row: add `treeRootTone`. */
export const TREE_ROOT_ROW = 'group h-7 gap-2 pl-6 pr-3 text-[15px] font-medium tracking-tight'

/** A root heading's colour: full while it is the one in use or on the way to it. */
export const treeRootTone = (on: boolean): string =>
  on ? 'text-foreground' : 'text-muted-foreground/70 hover:text-foreground'

/** A nested row, at `TREE_ROW` high: add `treeNestedTone`. */
export const TREE_NESTED_ROW = 'group gap-2 pr-3 text-[13px]'

/** A nested row's colour: the current row is bold, a row on its way full. */
export const treeNestedTone = (current: boolean, onPath: boolean): string =>
  current
    ? 'font-semibold text-foreground'
    : onPath
      ? 'text-foreground'
      : 'text-muted-foreground hover:text-foreground'

/** The column a row leads with (a chevron or a glyph), brand on the way down. */
export const treeLead = (onPath: boolean): string =>
  cn(
    'motion-respond flex w-3.5 shrink-0 justify-center',
    onPath ? 'text-brand' : 'text-muted-foreground group-hover:text-foreground',
  )

/** A group's rows, rendered while open and through the closing slide. Also
 *  the slide that makes room for a new row that is not one of the group's
 *  rows (`group={false}`). */
export function TreeDisclose({
  open,
  group = true,
  children,
}: {
  open: boolean
  group?: boolean
  children: ReactNode
}): React.JSX.Element | null {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) setMounted(true)
  }, [open])
  if (!mounted) return null
  return (
    <div
      data-slot="disclose"
      data-state={open ? 'open' : 'closed'}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && !open) setMounted(false)
      }}
    >
      <div role={group ? 'group' : undefined}>{children}</div>
    </div>
  )
}

/**
 * The connector into one row of a group: the rail down the left (not past the
 * last row), the elbow into this row, and, when the current row is further
 * down, the rail lit through. `lit` is this row being on the way.
 */
export function TreeConnector({
  last,
  lit,
  litThrough,
}: {
  last: boolean
  lit: boolean
  litThrough: boolean
}): React.JSX.Element {
  const elbow = `M 0.5 0 L 0.5 ${MID - RADIUS} Q 0.5 ${MID} ${RADIUS + 0.5} ${MID} L ${TREE_ELBOW - 4} ${MID}`
  return (
    <>
      {!last && <span aria-hidden className="absolute bottom-0 left-0 top-0 w-px bg-divider" />}
      <svg
        aria-hidden
        className="pointer-events-none absolute left-0 top-0"
        width={TREE_ELBOW}
        height={TREE_ROW}
        fill="none"
        strokeWidth={1}
        strokeLinecap="round"
      >
        <path d={elbow} className={lit ? 'stroke-brand' : 'stroke-divider'} />
      </svg>
      {/* Last, so no grey elbow above paints over the lit rail. */}
      {litThrough && <span aria-hidden className="absolute bottom-0 left-0 top-0 w-px bg-brand" />}
    </>
  )
}

/** One row of a group with its connector, and whatever hangs below it. */
export function TreeBranch({
  last,
  lit,
  litThrough,
  children,
}: {
  last: boolean
  lit: boolean
  litThrough: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="relative" style={{ paddingLeft: TREE_ELBOW }}>
      <TreeConnector last={last} lit={lit} litThrough={litThrough} />
      {children}
    </div>
  )
}

/**
 * The bar that marks the root in use and slides between roots. Measured, since
 * rows above it may be open and of any height: `selector` finds the marked
 * root's row inside `container`, and `deps` are what can move it.
 */
export function TreeBar({
  container,
  selector,
  deps,
}: {
  container: RefObject<HTMLElement | null>
  selector: string | null
  deps: readonly unknown[]
}): React.JSX.Element | null {
  const [bar, setBar] = useState<{ top: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const measure = () => {
      const row = selector ? container.current?.querySelector<HTMLElement>(selector) : null
      setBar((was) => {
        if (!row) return null
        const next = { top: row.offsetTop, height: row.offsetHeight }
        return was && was.top === next.top && was.height === next.height ? was : next
      })
    }
    measure()
    // Again as the tree resizes: a group above closing slides the row up
    // after this first measure, and the bar should arrive where it ends.
    const el = container.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selector, container, ...deps])
  if (bar === null) return null
  return (
    <span
      aria-hidden
      className="motion-respond absolute top-0 w-0.5 rounded-full bg-brand"
      style={{ left: 11.5, transform: `translateY(${bar.top + 6}px)`, height: bar.height - 12 }}
    />
  )
}
