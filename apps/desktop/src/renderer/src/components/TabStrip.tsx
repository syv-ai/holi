/**
 * One pane's tab strip.
 *
 * Lifted out of `Shell` because it had outgrown being a `map` inside a layout:
 * it measures itself, decides what to hide, and owns the control that says how
 * much. Being a component per pane is also what a split needs — the strip is
 * per-pane state (`pane.tabs`, `pane.active`), and a second pane is a second
 * strip rather than a shared one that has to know which pane a tab belongs to.
 *
 * **The bug it fixes.** The strip was a bare flex row: open more tabs than fit
 * between the sidebars and the row kept growing, pushing the editor pane wider
 * than the window, with nothing to say that had happened. Flex items do not
 * shrink below their content, so the pane grew forever.
 *
 * Two halves. The clip is CSS (`min-w-0` + `overflow-hidden` — both, because
 * `overflow-hidden` on a flex child that cannot shrink clips nothing). Which
 * tabs survive it is `lib/tab-window.ts`, which is pure and tested on numbers.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
} from '@/primitives'
import { CalendarDays, LayoutGrid, Mail, SquareKanban } from 'lucide-react'
import { fileIconFor } from '@/features/explorer/file-icons'
import { tabWindow } from '@/lib/tab-window'
import {
  SLIDE_MS,
  TAB_MIME,
  dropIndex,
  parseTabPayload,
  stripEdge,
  tabPayload,
  type PillBox,
} from '@/lib/tab-drop'
import type { Tab } from '@/state/panes'
import { snapshotAtom } from '@/state/vaults'

/** The singleton tabs' pill text and tooltip. Notes use their filename/path and
 *  apps use their id instead — both are keyed by something the tab carries
 *  rather than by its kind, so neither can live in a lookup like this. */
const TAB_NAME = { board: 'board', agenda: 'agenda', mail: 'mail' } as const
const TAB_LABEL: Partial<Record<string, string>> = {
  board: 'task board',
  agenda: 'your Google agenda',
  mail: 'your Gmail',
}

/** The strip's `gap-1`, in px — `tabWindow` counts the gaps between pills. */
const GAP = 4
/** What the "+N" control costs when it is drawn. A constant rather than a
 *  measurement: it is only ever a couple of digits wide, and measuring it would
 *  make the reserved width depend on whether it is currently shown — which is
 *  the thing being decided. Slack here is harmless; a shortfall would clip it. */
const OVERFLOW_WIDTH = 48

/** A tab's stable identity, for React keys and for the measured-width cache. */
export function tabKey(tab: Tab): string {
  return tab.kind === 'note' ? `note:${tab.path}` : tab.kind === 'app' ? `app:${tab.appId}` : tab.kind
}

/** `icons` is `.holi/icons.json` as the snapshot resolved it (D82), keyed by
 *  vault-relative path. It has to be passed in rather than read here: this is a
 *  module-level function, and the tree already proves the map belongs to the
 *  snapshot and not to a store of its own. Only a note tab can carry one — the
 *  singleton tabs are not files and have no path to key by. */
function tabIcon(tab: Tab, icons: Record<string, string>): ReactNode {
  if (tab.kind === 'note') return fileIconFor(tab.path, icons[tab.path])
  if (tab.kind === 'app') return <LayoutGrid size={14} />
  if (tab.kind === 'agenda') return <CalendarDays size={14} />
  if (tab.kind === 'mail') return <Mail size={14} />
  return <SquareKanban size={14} />
}

function tabName(tab: Tab): string {
  if (tab.kind === 'note') return tab.path.split('/').at(-1) ?? tab.path
  if (tab.kind === 'app') return tab.appId
  return TAB_NAME[tab.kind]
}

function tabTooltip(tab: Tab): string {
  return (
    TAB_LABEL[tab.kind] ??
    (tab.kind === 'note' ? tab.path : tab.kind === 'app' ? `the ${tab.appId} app` : tab.kind)
  )
}

export interface TabStripProps {
  tabs: Tab[]
  /** Index into `tabs`; `-1` for an empty pane. */
  active: number
  onSelect: (index: number) => void
  /** Double-click promotes a preview tab (the VS Code rule). */
  onPin: (index: number) => void
  onClose: (index: number) => void
  /** Whether this pane is the focused one. An unfocused pane's active tab keeps
   *  its shape but loses its weight, so two strips side by side say which one
   *  the next opened file will land in. Defaults to true — with a single pane
   *  there is nothing to distinguish it from. */
  focused?: boolean
  /** A tab was dropped on this strip, to sit before `index` — which is absolute,
   *  not an offset into the visible window. The tab may have come from this
   *  strip (a reorder) or from another pane's; the handler does not need to
   *  know, because `moveTab` finds it wherever it is. Absent means this strip
   *  takes no drops. */
  onDropTab?: (tab: Tab, index: number) => void
  /** A drag started from *this* strip, carrying that tab. The workspace uses it
   *  to work out which drops would do anything at all — see `dropZones`. */
  onDragBegin?: (tab: Tab) => void
  /** Controls pinned to the right-hand end, outside the clip (version history). */
  trailing?: ReactNode
}

export function TabStrip({
  tabs,
  active,
  onSelect,
  onPin,
  onClose,
  focused = true,
  onDropTab,
  onDragBegin,
  trailing,
}: TabStripProps) {
  // Read here rather than taken as a prop: every pane's strip wants the same
  // map, and threading it through `PaneView` would make each caller repeat a
  // lookup that has exactly one answer.
  const icons = useAtomValue(snapshotAtom).icons
  const hostRef = useRef<HTMLDivElement | null>(null)
  const pillRefs = useRef(new Map<string, HTMLElement>())
  const [available, setAvailable] = useState(0)
  /**
   * Measured pill widths, by tab key.
   *
   * Cached rather than measured on demand, because a hidden tab is not in the
   * DOM to measure: it was measured while visible and keeps that width. A tab
   * that has NEVER been rendered has no entry and counts as zero — which is
   * fine, because a newly-opened tab is also the active one, so the window
   * slides to include it and it is measured on the next frame.
   */
  const [widths, setWidths] = useState<Record<string, number>>({})
  /**
   * Where the dragged tab would land, and where to draw the line saying so.
   *
   * `x` is carried alongside the index rather than derived at render time,
   * because deriving it means reading pill rects — and the drag handler has
   * already read them. It is an offset inside the host, so it survives the
   * strip being scrolled by anything else on screen.
   */
  const [caret, setCaret] = useState<{ index: number; x: number } | null>(null)
  /**
   * The index the window must keep visible *while a drag is in flight*.
   *
   * A drop position that is currently clipped is otherwise unreachable — the
   * strip only slides for the **active** tab, so "move this to position 9 of
   * 12" cannot be expressed at all. No new windowing logic is needed for it:
   * `tabWindow`'s third rule is already "this index must stay visible", and
   * `active` is merely its usual caller. A drag substitutes its own.
   */
  const [dragFocus, setDragFocus] = useState<number | null>(null)
  /** The running slide, and which way it is going — kept in a ref so that the
   *  continuous stream of `dragover` events does not restart the timer on every
   *  frame and freeze the strip one step from where it started. */
  const slideRef = useRef<{ edge: 'left' | 'right'; timer: ReturnType<typeof setInterval> } | null>(
    null,
  )

  const stopSliding = () => {
    if (slideRef.current !== null) clearInterval(slideRef.current.timer)
    slideRef.current = null
  }

  // A drag can end without this strip hearing about it: dropped on another pane,
  // or cancelled with escape while the pointer sits right here — in which case
  // `dragend` fires on the source pill, which may be in a different pane
  // entirely. Left alone, this strip would keep a caret drawn and a window slid
  // for a drag that finished a minute ago. Listening on the window catches every
  // ending; the cleanup covers unmounting mid-drag.
  useEffect(() => {
    const clear = () => {
      if (slideRef.current !== null) clearInterval(slideRef.current.timer)
      slideRef.current = null
      setCaret(null)
      setDragFocus(null)
    }
    window.addEventListener('dragend', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      clear()
    }
  }, [])

  const endDrag = () => {
    stopSliding()
    setCaret(null)
    setDragFocus(null)
  }

  // The strip's own width, which is the pane's width minus the trailing
  // controls. A ResizeObserver rather than a window listener: the pane resizes
  // when the sidebars or the agent drawer are dragged, not only when the window
  // is.
  useLayoutEffect(() => {
    const el = hostRef.current
    if (el === null) return
    const measure = () => setAvailable(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Measure whatever is currently rendered and write back only on a change —
  // which is what makes this converge instead of looping. Hiding a tab does not
  // change the width of the ones still shown, so the second pass is the last
  // one. `useLayoutEffect` so the correction lands before paint.
  //
  // The dependencies are everything the rendered set is derived from, which is
  // the same as saying "whenever the pills may have changed".
  useLayoutEffect(() => {
    let changed = false
    const next = { ...widths }
    for (const [key, el] of pillRefs.current) {
      const measured = Math.ceil(el.getBoundingClientRect().width)
      if (measured > 0 && next[key] !== measured) {
        next[key] = measured
        changed = true
      }
    }
    // Forget tabs that are gone, so a long session does not accumulate widths
    // for every file ever opened.
    const live = new Set(tabs.map(tabKey))
    for (const key of Object.keys(next)) {
      if (!live.has(key)) {
        delete next[key]
        changed = true
      }
    }
    if (changed) setWidths(next)
    // `dragFocus` belongs here: nothing else in this list changes when the
    // window slides, so pills the slide reveals would stay measured at 0 and
    // `tabWindow` would miscount from then on.
  }, [tabs, widths, available, active, dragFocus])

  const window_ = tabWindow({
    widths: tabs.map((t) => widths[tabKey(t)] ?? 0),
    available,
    // While dragging, the window follows the pointer instead of the selection.
    active: dragFocus ?? active,
    overflowWidth: OVERFLOW_WIDTH,
    gap: GAP,
  })
  const shown = tabs.slice(window_.start, window_.end)

  /**
   * The visible pills, measured now, carrying **absolute** indices.
   *
   * Read live rather than from the `widths` cache: the cache exists so a hidden
   * tab keeps a width, and it holds no `left`. A drop needs where a pill *is*,
   * which only the DOM knows.
   */
  const pillBoxes = (): PillBox[] => {
    const boxes: PillBox[] = []
    shown.forEach((t, offset) => {
      const el = pillRefs.current.get(tabKey(t))
      if (el === undefined) return
      const rect = el.getBoundingClientRect()
      boxes.push({ index: window_.start + offset, left: rect.left, width: rect.width })
    })
    return boxes
  }

  /** Whether this drag is one of ours. `getData` is empty during `dragover` by
   *  spec, so the MIME type is the only question a target may ask mid-drag. */
  const carriesTab = (e: React.DragEvent) => e.dataTransfer.types.includes(TAB_MIME)

  /**
   * Slide the window one tab per tick while the pointer sits at an end.
   *
   * `seed` is where to start counting from when nothing has slid yet — the
   * outermost visible tab on that side, so the first step immediately reveals
   * one more rather than re-selecting one already on screen. Re-arming is
   * suppressed while the same edge is already running: `dragover` fires
   * continuously, and restarting the interval on each one would reset the timer
   * forever and the strip would never reach the second step.
   */
  const slide = (edge: 'left' | 'right' | null, seed: number) => {
    if (edge === null) return stopSliding()
    if (slideRef.current?.edge === edge) return
    stopSliding()
    const step = edge === 'left' ? -1 : 1
    const clamp = (i: number) => Math.max(0, Math.min(i, tabs.length - 1))
    const advance = () => setDragFocus((prev) => clamp((prev ?? seed) + step))
    // One step now, then on the timer — a hover that has already arrived at the
    // edge should do something before it does nothing for SLIDE_MS.
    advance()
    slideRef.current = { edge, timer: setInterval(advance, SLIDE_MS) }
  }

  const dragOver = (e: React.DragEvent) => {
    if (onDropTab === undefined || !carriesTab(e)) return
    // Without this the drop event never fires — the commonest way HTML5
    // drag-and-drop silently does nothing at all.
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    const boxes = pillBoxes()
    const index = dropIndex(boxes, e.clientX)
    const host = hostRef.current?.getBoundingClientRect()
    if (host === undefined) return
    const at = boxes.find((b) => b.index === index)
    const last = boxes.at(-1)
    const x =
      at !== undefined
        ? at.left - host.left
        : last !== undefined
          ? last.left + last.width - host.left
          : 0
    setCaret({ index, x })

    // Hovering an end slides the window that way, so a clipped position is
    // reachable. The seed is the outermost tab currently visible on that side.
    const edge = stripEdge(host, e.clientX)
    slide(edge, edge === 'left' ? window_.start : window_.end - 1)
  }

  const drop = (e: React.DragEvent) => {
    endDrag()
    const tab = parseTabPayload(e.dataTransfer.getData(TAB_MIME))
    if (tab === null) return
    e.preventDefault()
    // Recomputed rather than read off `caret`: the drop must land where the
    // pointer is, even if no `dragover` was recorded for this exact position.
    onDropTab?.(tab, dropIndex(pillBoxes(), e.clientX))
  }
  const hiddenTabs = [
    ...tabs.slice(0, window_.start).map((tab, i) => ({ tab, index: i })),
    ...tabs.slice(window_.end).map((tab, i) => ({ tab, index: window_.end + i })),
  ]

  return (
    <div className="flex h-11 min-w-0 items-center px-2">
      <div
        ref={hostRef}
        className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
        data-testid="tab-strip"
        onDragOver={dragOver}
        onDragLeave={(e) => {
          // `dragleave` also fires when the pointer crosses into a child, so
          // clear only when the host itself was actually left.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          endDrag()
        }}
        onDrop={drop}
      >
        {/* Where it would land. Absolutely positioned on purpose: a real spacer
            would change a measured pill width, and the measure effect calls
            `setWidths` from inside itself — it converges only because it writes
            on a change, so a width that moved with the pointer would oscillate. */}
        {caret !== null && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
            style={{ left: Math.max(0, caret.x - 1) }}
          />
        )}
        {shown.map((t, offset) => {
          const i = window_.start + offset
          const key = tabKey(t)
          return (
            <span
              key={key}
              ref={(el) => {
                if (el === null) pillRefs.current.delete(key)
                else pillRefs.current.set(key, el)
              }}
              // On the pill, not on the Radix trigger and not on the Button —
              // `BoardView` puts it on the card `div` for the same reason.
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_MIME, tabPayload(t))
                e.dataTransfer.effectAllowed = 'move'
                onDragBegin?.(t)
              }}
              onDragEnd={endDrag}
              className={`group flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs ${
                i === active
                  ? focused
                    ? 'bg-secondary text-foreground'
                    : 'bg-secondary/40 text-muted-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Tooltip content={tabTooltip(t)}>
                <Button
                  variant="ghost"
                  // Bare clickable on the pill — neutralise the ghost bg/padding so
                  // the pill owns the surface. A preview tab reads italic (VS Code);
                  // double-clicking it pins it, the same promotion editing performs.
                  //
                  // The nudge is what keeps an unhovered tab looking centred. The
                  // close control holds its width while invisible, which leaves
                  // 4 + 10.7 + 12 = 26.7px of air to the label's right against
                  // 12px to its left; half that excess, given back as a
                  // transform, splits it evenly. A transform and not padding,
                  // because the strip measures every pill and caches the width —
                  // anything that changed the LAYOUT on hover would re-measure
                  // and could slide a tab out of the window under the pointer.
                  // Hovering hands the space back, so the ✕ arrives into a gap
                  // rather than up against the pill's edge.
                  className={`h-auto translate-x-[7px] gap-1.5 p-0 transition-transform duration-(--duration-micro) ease-settle group-hover:translate-x-0 hover:bg-transparent ${
                    t.kind === 'note' && t.preview ? 'italic' : ''
                  }`}
                  onClick={() => onSelect(i)}
                  onDoubleClick={() => onPin(i)}
                >
                  {tabIcon(t, icons)}
                  <span>{tabName(t)}</span>
                </Button>
              </Tooltip>
              {/* Shown on hover of its own pill, and whenever it is focused so
                  the keyboard can still reach it. Hidden with `opacity`, never
                  `hidden` — the strip measures each pill and caches the width,
                  so a control that came and went with the pointer would change
                  the measurement under a `useLayoutEffect` that writes back on
                  a change, and the pill would re-measure on every hover. */}
              <Tooltip content="close tab">
                <Button
                  variant="ghost"
                  className="h-auto p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-transparent hover:text-foreground focus-visible:opacity-100"
                  onClick={() => onClose(i)}
                >
                  ✕
                </Button>
              </Tooltip>
            </span>
          )
        })}

        {/* What did not fit, and how to get to it. The count is the whole point:
            without it a full strip is indistinguishable from a strip that lost
            your tab. */}
        {window_.hidden > 0 && (
          <DropdownMenu>
            <Tooltip content={`${window_.hidden} more tab${window_.hidden === 1 ? '' : 's'}`}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  className="shrink-0 rounded-full text-muted-foreground"
                  aria-label={`${window_.hidden} more tabs`}
                >
                  +{window_.hidden}
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end">
              {hiddenTabs.map(({ tab, index }) => (
                <DropdownMenuItem
                  key={tabKey(tab)}
                  className="gap-2 text-xs"
                  onSelect={() => onSelect(index)}
                >
                  {tabIcon(tab, icons)}
                  <span className={tab.kind === 'note' && tab.preview ? 'italic' : ''}>
                    {tabName(tab)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {trailing}
    </div>
  )
}
