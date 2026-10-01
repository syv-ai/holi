/**
 * One pane's tab strip. Per pane because tabs are per-pane state.
 *
 * Pills scroll inside an `overflow-x-auto` viewport, and what is off each edge
 * is counted per side by `lib/tab-overflow.ts` (pure, because jsdom computes no
 * layout). A single "+N" count was rejected: it cannot say which way a tab went.
 *
 * A reorder is shown, not described: pills slide aside to open the hole
 * (`lib/tab-reorder.ts`). The caret line is only for a tab arriving from
 * another pane, which has no slot here and a width this strip cannot know.
 * Every other position change glides rather than snaps.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Tooltip,
} from '@/primitives'
import { Bot, ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { TaskStatus } from '@holi/shared'
import { pathGlyph, pathLabel } from '@/composites/file-icons'
import { surfaceLabel } from '@/lib/folder-documents'
import { offscreenTabs, type Offscreen } from '@/lib/tab-overflow'
import { reorderOffsets } from '@/lib/tab-reorder'
import {
  AUTOSCROLL_MS,
  AUTOSCROLL_PX,
  TAB_MIME,
  dropIndex,
  parseTabPayload,
  stripEdge,
  tabPayload,
  type PillBox,
} from '@/lib/tab-drop'
import type { Surface } from '@/plugin-api/types'
import type { Tab } from '@/state/panes'
import { surfacesAtom } from '@/state/plugins'
import {
  agentSessionsAtom,
  agentTabId,
  agentTerminalsAtom,
  terminalLabel,
  type AgentSession,
  type AgentTerminal,
} from '@/state/agent'
import { agentIndicator } from '@/lib/agent-notices'
import { cn } from '@/lib/cn'
import { snapshotAtom } from '@/state/vaults'

/** The strip's `gap-1`, in px: the caret is drawn in the gap before a pill. */
const GAP = 4

/** One identity for "nothing is off either edge", so the common case does not
 *  hand React a new object on every scroll event. */
const NOTHING_OFFSCREEN: Offscreen = { left: [], right: [] }

const sameSides = (a: Offscreen, b: Offscreen): boolean =>
  a.left.length === b.left.length &&
  a.right.length === b.right.length &&
  a.left.every((v, i) => v === b.left[i]) &&
  a.right.every((v, i) => v === b.right[i])

/**
 * The motion tier, in the numbers the Web Animations API takes.
 *
 * Read off the document because a WAAPI keyframe cannot carry a `var()`, and
 * per use so a theme change leaves no stale copy. The motion tracks the
 * pointer, so it is `--motion-respond`.
 *
 * This reads the token by name: rename it in index.css and the fallback
 * silently takes over. Keep the fallback equal to the token.
 */
function settleMotion(): { duration: number; easing: string } {
  const style = getComputedStyle(document.documentElement)
  const ms = Number.parseFloat(style.getPropertyValue('--motion-respond'))
  const easing = style.getPropertyValue('--ease-settle').trim()
  return {
    duration: Number.isFinite(ms) ? ms : 150,
    easing: easing === '' ? 'ease-out' : easing,
  }
}

/** A tab's stable identity, for React keys and for the pill-element map. */
export function tabKey(tab: Tab): string {
  return tab.kind === 'note' ? `note:${tab.path}` : `surface:${tab.surface}:${tab.id ?? ''}`
}

/** What a vault file is marked with here and in the tree alike. `icons`
 *  is `.holi/settings/icons.yaml` as the snapshot resolved it, and
 *  `tasks` each task file's status, both keyed by vault-relative path. */
interface PathMarks {
  icons: Record<string, string>
  tasks: ReadonlyMap<string, TaskStatus>
}

/** The vault's sessions and Holi's terminals, what an agent tab is named and
 *  marked from, and the registry a surface tab is. */
interface TabSources {
  sessions: AgentSession[]
  terminals: AgentTerminal[]
  surfaces: ReadonlyMap<string, Surface>
}

/** The live session the agent terminal `id` was opened for, if it has one. */
function sessionOf(id: string, agents: TabSources): AgentSession | null {
  const launchedFor = agents.terminals.find((t) => t.id === id)?.launchedFor ?? null
  return agents.sessions.find((s) => s.id === launchedFor) ?? null
}

/** A note leads with nothing, as its tree row does; the pill keeps no empty
 *  slot, since nothing here lines up with it. */
function tabIcon(tab: Tab, marks: PathMarks, agents: TabSources): ReactNode {
  if (tab.kind === 'note') {
    return pathGlyph(tab.path, { emoji: marks.icons[tab.path], task: marks.tasks.get(tab.path) })
  }
  const agentId = agentTabId(tab)
  if (agentId !== null) {
    // A tab opened for a session that is still live carries its state: the
    // same dot, from the same derivation, as its sidebar row. Anything else
    // (the list, or a session that has gone) is Claude Code's glyph.
    const session = sessionOf(agentId, agents)
    if (session === null) return <Icon icon={Bot} size="sm" />
    const dot = agentIndicator(session).dot
    return <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
  }
  const surface = agents.surfaces.get(tab.surface)
  if (surface === undefined) return null
  // A folder document (an app) wears the vault icon map's emoji, as its
  // tree row does.
  const emoji = tab.id === undefined ? undefined : marks.icons[tab.id]
  return emoji ? pathGlyph(tab.id!, { emoji }) : <Icon icon={surface.icon} size="sm" />
}

function tabName(tab: Tab, agents: TabSources): string {
  if (tab.kind === 'note') return pathLabel(tab.path)
  // The terminal's own title, which Claude Code sets to what it is showing.
  const agentId = agentTabId(tab)
  if (agentId !== null) {
    return terminalLabel(agents.terminals.find((t) => t.id === agentId) ?? null, agents.sessions)
  }
  const surface = agents.surfaces.get(tab.surface)
  return surface === undefined ? tab.surface : surfaceLabel(surface, tab.id)
}

function tabTooltip(tab: Tab, agents: TabSources): string {
  if (tab.kind === 'note') return tab.path
  const agentId = agentTabId(tab)
  if (agentId !== null) {
    const session = sessionOf(agentId, agents)
    return session === null ? 'Claude Code' : agentIndicator(session).title
  }
  const surface = agents.surfaces.get(tab.surface)
  if (surface === undefined) return tab.surface
  // One of many (an app): its label and its path.
  return tab.id === undefined
    ? surfaceLabel(surface)
    : `${surfaceLabel(surface, tab.id)}, ${tab.id}`
}

/**
 * What is off one edge, and how to get to it.
 *
 * One per side, so it says which way. Picking a name uses `onReveal`, not
 * `onSelect`: the tab may already be active, and re-selecting scrolls nothing.
 *
 * It floats over the strip's edge and is always mounted: outside the layout it
 * cannot re-lay the pills out as it appears, and mounted it can fade instead
 * of blinking. The gradient keeps a pill scrolling beneath it legible.
 */
function OverflowMenu({
  side,
  indices,
  tabs,
  marks,
  agents,
  onReveal,
}: {
  side: 'left' | 'right'
  indices: number[]
  tabs: Tab[]
  marks: PathMarks
  agents: TabSources
  onReveal: (index: number) => void
}) {
  const visible = indices.length > 0
  /** The last non-empty list, kept on screen while the control fades out, so
   *  what fades is not a blank pill. */
  const [shown, setShown] = useState(indices)
  useEffect(() => {
    if (indices.length > 0) setShown(indices)
  }, [indices])

  const label = `${shown.length} tab${shown.length === 1 ? '' : 's'} off the ${side}`
  return (
    <div
      className={`pointer-events-none absolute inset-y-0 z-10 flex items-center ${
        side === 'left' ? 'left-0 bg-linear-to-r pr-6 pl-0' : 'right-0 bg-linear-to-l pr-0 pl-6'
      } motion-respond from-background from-60% to-transparent ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <DropdownMenu>
        <Tooltip content={label}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className={`shrink-0 gap-0 rounded-full px-1.5 text-muted-foreground ${
                visible ? 'pointer-events-auto' : 'pointer-events-none'
              }`}
              aria-label={label}
              // Out of the a11y tree and tab order while invisible: it stays in
              // the DOM only so it can fade.
              aria-hidden={!visible}
              tabIndex={visible ? undefined : -1}
            >
              {side === 'left' && <Icon icon={ChevronLeft} size="sm" />}
              {shown.length}
              {side === 'right' && <Icon icon={ChevronRight} size="sm" />}
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align={side === 'left' ? 'start' : 'end'}>
          {shown.map((index) => {
            const tab = tabs[index]
            if (tab === undefined) return null
            return (
              <DropdownMenuItem
                key={tabKey(tab)}
                className="gap-2 text-xs"
                onSelect={() => onReveal(index)}
              >
                {tabIcon(tab, marks, agents)}
                <span className={tab.kind === 'note' && tab.preview ? 'italic' : ''}>
                  {tabName(tab, agents)}
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
  /** Whether this pane is the focused one. An unfocused pane's active tab loses
   *  its weight, so split strips say where the next file will land. */
  focused?: boolean
  /** A tab was dropped here, to sit before `index`, from this strip or another
   *  (`moveTab` finds it). Absent means this strip takes no drops. */
  onDropTab?: (tab: Tab, index: number) => void
  /** A drag started from this strip; the workspace uses it for `dropZones`. */
  onDragBegin?: (tab: Tab) => void
  /** A tab drag entered or left this strip. The workspace hides the panes'
   *  landing strips meanwhile: a reorder should not light up the pane below. */
  onDragOverStrip?: (over: boolean) => void
  /** Controls pinned to the right-hand end, outside the scroll (version history). */
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
  onDragOverStrip,
  trailing,
}: TabStripProps) {
  const snapshot = useAtomValue(snapshotAtom)
  const marks = useMemo<PathMarks>(
    () => ({
      icons: snapshot.icons,
      tasks: new Map(snapshot.tasks.map((t) => [t.path, t.status])),
    }),
    [snapshot],
  )
  const sessions = useAtomValue(agentSessionsAtom)
  const terminals = useAtomValue(agentTerminalsAtom)
  const surfaces = useAtomValue(surfacesAtom)
  const agents = useMemo<TabSources>(
    () => ({ sessions, terminals, surfaces }),
    [sessions, terminals, surfaces],
  )
  const hostRef = useRef<HTMLDivElement | null>(null)
  const pillRefs = useRef(new Map<string, HTMLElement>())
  /** Where the dragged tab would land. `x` is in the scroller's content
   *  coordinates, since the caret is positioned inside the scroller. */
  const [caret, setCaret] = useState<{ index: number; x: number } | null>(null)
  const [offscreen, setOffscreen] = useState<Offscreen>(NOTHING_OFFSCREEN)
  /**
   * The previewed reorder: one x-offset per tab, or null.
   *
   * Null and all-zeros differ. Zeros keep the transition, so a cancelled drag
   * glides home. Null drops the transition too, so a drop is invisible: the
   * real positions become what the offsets showed, with nothing to animate.
   */
  const [shift, setShift] = useState<number[] | null>(null)
  /** The pill this strip is dragging from. Null for a tab from another pane. */
  const [dragFromKey, setDragFromKey] = useState<string | null>(null)
  /** Set on the commit a drop lands, so the settle does not animate a move the
   *  preview already showed. */
  const landedRef = useRef(false)
  /** The running auto-scroll, in a ref so continuous `dragover` does not
   *  restart the timer every frame. */
  const scrollRef = useRef<{
    edge: 'left' | 'right'
    timer: ReturnType<typeof setInterval>
  } | null>(null)

  /** Report a crossing only: `dragover` fires continuously and each report
   *  re-renders every pane. */
  const overRef = useRef(false)
  const reportOver = (over: boolean) => {
    if (overRef.current === over) return
    overRef.current = over
    onDragOverStrip?.(over)
  }

  const stopScrolling = () => {
    if (scrollRef.current !== null) clearInterval(scrollRef.current.timer)
    scrollRef.current = null
  }

  // A drag can end without this strip hearing: dropped elsewhere, or cancelled
  // here while `dragend` fires on a source pill in another pane. The window
  // listener catches every ending; the cleanup covers unmounting mid-drag.
  useEffect(() => {
    const clear = () => {
      if (scrollRef.current !== null) clearInterval(scrollRef.current.timer)
      scrollRef.current = null
      setCaret(null)
      setDragFromKey(null)
      setShift((prev) => (prev === null ? null : prev.map(() => 0)))
      // Deliberately no crossing report: this listener is installed once, so a
      // prop would go stale, and the workspace clears its own state on
      // `dragend`.
    }
    window.addEventListener('dragend', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      clear()
    }
  }, [])

  const endDrag = () => {
    stopScrolling()
    reportOver(false)
    setCaret(null)
    setDragFromKey(null)
    // Zeros, not null: a drag without a drop glides home. See `shift`.
    setShift((prev) => (prev === null ? null : prev.map(() => 0)))
  }

  // What is off each edge, on scroll, resize or tab change. Written back only
  // on a change, since scroll fires continuously. `offsetLeft` rather than
  // `getBoundingClientRect`: content coordinates, the frame `offscreenTabs`
  // reasons in.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const measure = () => {
      const pills = tabs.map((tab) => {
        const el = pillRefs.current.get(tabKey(tab))
        return el === undefined
          ? { left: 0, width: 0 }
          : { left: el.offsetLeft, width: el.offsetWidth }
      })
      const next = offscreenTabs(pills, host.scrollLeft, host.clientWidth)
      setOffscreen((prev) => (sameSides(prev, next) ? prev : next))
    }
    measure()
    host.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => {
      host.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [tabs])

  /**
   * Keep the active tab reachable. Keyed on its identity: the index would miss
   * a different tab at the same index, and `tabs` would yank the scroll back
   * after every reorder.
   */
  const activeTab = active >= 0 ? tabs[active] : undefined
  const activeKey = activeTab === undefined ? null : tabKey(activeTab)
  useLayoutEffect(() => {
    if (activeKey === null) return
    pillRefs.current.get(activeKey)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeKey])

  /**
   * Glide, rather than snap, to a new position.
   *
   * FLIP: each commit records where pills sit, and a moved pill is transformed
   * back and animated to zero. Layout is never animated, so drop hit-testing
   * is unaffected.
   *
   * The frame is the viewport (`offsetLeft - scrollLeft`): closing a tab while
   * scrolled shortens the scroll too, so pills stay put on screen while their
   * `offsetLeft` changes. Content coordinates would fling them.
   *
   * It runs only when the key list changed (scrolling must never animate), and
   * not on the commit a drop lands (see `shift`). No dependency array on
   * purpose: it asks the DOM after every commit.
   */
  const restingRef = useRef(new Map<string, number>())
  const keysRef = useRef('')
  useLayoutEffect(() => {
    const scrollLeft = hostRef.current?.scrollLeft ?? 0
    const now = new Map<string, number>()
    for (const [key, el] of pillRefs.current) now.set(key, el.offsetLeft - scrollLeft)

    const keys = tabs.map(tabKey).join('|')
    if (keys !== keysRef.current && !landedRef.current) {
      const motion = settleMotion()
      for (const [key, x] of now) {
        const was = restingRef.current.get(key)
        const el = pillRefs.current.get(key)
        if (was === undefined || was === x || el === undefined) continue
        // Optional call: jsdom implements no Web Animations.
        el.animate?.(
          [{ transform: `translateX(${was - x}px)` }, { transform: 'translateX(0)' }],
          motion,
        )
      }
    }
    landedRef.current = false
    keysRef.current = keys
    restingRef.current = now
  })

  /** Select and scroll into view: the tab may already be active, so
   *  `onSelect` alone would move nothing. */
  const reveal = (index: number) => {
    onSelect(index)
    const tab = tabs[index]
    if (tab === undefined) return
    pillRefs.current
      .get(tabKey(tab))
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }

  /**
   * The pills' resting positions, in `clientX` coordinates. `offsetLeft`, not
   * `getBoundingClientRect`: a rect includes the preview's `translateX`, and
   * the hole would chase the pointer that opened it.
   */
  const pillBoxes = (): PillBox[] => {
    const host = hostRef.current
    if (host === null) return []
    const origin = host.getBoundingClientRect().left - host.scrollLeft
    const boxes: PillBox[] = []
    tabs.forEach((t, index) => {
      const el = pillRefs.current.get(tabKey(t))
      if (el === undefined) return
      boxes.push({ index, left: origin + el.offsetLeft, width: el.offsetWidth })
    })
    return boxes
  }

  /** Whether this drag is one of ours. `getData` is empty during `dragover`,
   *  so the MIME type is all a target can check mid-drag. */
  const carriesTab = (e: React.DragEvent) => e.dataTransfer.types.includes(TAB_MIME)

  /**
   * Scroll while the pointer sits at an end of the strip: the wheel does not
   * work mid-drag. Not re-armed for the same edge, or continuous `dragover`
   * would reset the interval forever.
   */
  const autoScroll = (edge: 'left' | 'right' | null) => {
    if (edge === null) return stopScrolling()
    if (scrollRef.current?.edge === edge) return
    stopScrolling()
    const step = edge === 'left' ? -AUTOSCROLL_PX : AUTOSCROLL_PX
    const advance = () => {
      const host = hostRef.current
      if (host !== null) host.scrollLeft += step
    }
    // One step now, then on the timer.
    advance()
    scrollRef.current = { edge, timer: setInterval(advance, AUTOSCROLL_MS) }
  }

  /** Where to draw the caret for a drop before `index`, in content coordinates:
   *  in the gap ahead of that pill, or past the end of the last one. */
  const caretX = (index: number): number => {
    const tab = tabs[index]
    const el = tab === undefined ? undefined : pillRefs.current.get(tabKey(tab))
    if (el !== undefined) return el.offsetLeft - GAP / 2
    const last = tabs.at(-1)
    const lastEl = last === undefined ? undefined : pillRefs.current.get(tabKey(last))
    return lastEl === undefined ? 0 : lastEl.offsetLeft + lastEl.offsetWidth + GAP / 2
  }

  const dragOver = (e: React.DragEvent) => {
    if (onDropTab === undefined || !carriesTab(e)) return
    // Without this the drop event never fires.
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    reportOver(true)

    const index = dropIndex(pillBoxes(), e.clientX)
    // Our own tab previews the move; one from another pane gets the caret.
    const from = dragFromKey === null ? -1 : tabs.findIndex((t) => tabKey(t) === dragFromKey)
    if (from >= 0) {
      const widths = tabs.map((t) => pillRefs.current.get(tabKey(t))?.offsetWidth ?? 0)
      setShift(reorderOffsets(widths, from, index, GAP))
      setCaret(null)
    } else {
      setCaret({ index, x: caretX(index) })
    }

    const host = hostRef.current?.getBoundingClientRect()
    if (host !== undefined) autoScroll(stripEdge(host, e.clientX))
  }

  const drop = (e: React.DragEvent) => {
    stopScrolling()
    reportOver(false)
    setCaret(null)
    setDragFromKey(null)
    // Null, and the settle skips this commit: the preview already showed the
    // move. See `shift`.
    landedRef.current = true
    setShift(null)
    const tab = parseTabPayload(e.dataTransfer.getData(TAB_MIME))
    if (tab === null) return
    e.preventDefault()
    // Recomputed rather than read off `caret`: land where the pointer is.
    onDropTab?.(tab, dropIndex(pillBoxes(), e.clientX))
  }

  /** A vertical wheel scrolls the strip sideways, for mice without a
   *  horizontal wheel. A trackpad's horizontal delta is left to the browser. */
  const wheel = (e: React.WheelEvent) => {
    const host = hostRef.current
    if (host === null || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    host.scrollLeft += e.deltaY
  }

  return (
    <div className="flex h-11 min-w-0 items-center gap-1 px-2">
      {/* The frame the side counts float in, so they sit on the scroller's
          edges and `trailing` keeps its place. */}
      <div className="relative flex min-w-0 flex-1 items-center">
        <div
          ref={hostRef}
          // `min-w-0`: without it the flex row grows the pane instead of
          // scrolling. The scrollbar is hidden; the side counts say there is
          // more.
          className="relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
          data-testid="tab-strip"
          onDragOver={dragOver}
          onDragLeave={(e) => {
            // `dragleave` also fires when the pointer crosses into a child, so
            // clear only when the host itself was actually left.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            endDrag()
          }}
          onDrop={drop}
          onWheel={wheel}
        >
          {/* Absolutely positioned: a real spacer would move the midpoints the
            drop is computed from. */}
          {caret !== null && (
            <div
              aria-hidden
              data-testid="tab-caret"
              className="pointer-events-none absolute top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
              style={{ left: Math.max(0, caret.x - 1) }}
            />
          )}
          {tabs.map((t, i) => {
            const key = tabKey(t)
            return (
              <span
                key={key}
                ref={(el) => {
                  if (el === null) pillRefs.current.delete(key)
                  else pillRefs.current.set(key, el)
                }}
                // On the pill, not on the Radix trigger or the Button.
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(TAB_MIME, tabPayload(t))
                  e.dataTransfer.effectAllowed = 'move'
                  setDragFromKey(key)
                  onDragBegin?.(t)
                }}
                onDragEnd={endDrag}
                // The preview is a transform, never layout. A dragged pill dims
                // to 40%, like a cut tree row.
                //
                // Only the property list is conditional: a drop must clear the
                // transition as well as the transform (see `shift`). Timing
                // comes from `motion-respond`.
                style={{
                  transform: shift === null ? undefined : `translateX(${shift[i] ?? 0}px)`,
                  transitionProperty: shift === null ? 'opacity' : 'opacity, transform',
                }}
                className={`motion-respond group group/tab flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs ${
                  dragFromKey === key ? 'opacity-40' : ''
                } ${
                  i === active
                    ? focused
                      ? 'bg-secondary text-foreground'
                      : 'bg-secondary/40 text-muted-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Tooltip content={tabTooltip(t, agents)}>
                  <Button
                    variant="ghost"
                    // Ghost bg/padding neutralised so the pill owns the surface.
                    // A preview tab reads italic (VS Code).
                    //
                    // The 10px nudge centres an unhovered label against the
                    // invisible close control's reserved width. A transform, not
                    // padding: a pill changing width on hover would shift the
                    // pills after it and the drop midpoints.
                    className={`motion-respond h-auto translate-x-[10px] gap-1.5 p-0 group-hover/tab:translate-x-0 hover:bg-transparent ${
                      t.kind === 'note' && t.preview ? 'italic' : ''
                    }`}
                    onClick={() => onSelect(i)}
                    // Double-click pins a preview note.
                    onDoubleClick={() => onPin(i)}
                  >
                    {tabIcon(t, marks, agents)}
                    <span>{tabName(t, agents)}</span>
                  </Button>
                </Tooltip>
                {/* Shown on hover or focus. Hidden with `opacity`, never
                  `hidden`, so the pill's width never changes. */}
                <IconButton
                  icon={X}
                  label="close tab"
                  shape="round"
                  // Boxed to the pill's line height, so it never makes the pill
                  // taller than its label.
                  className="size-4 opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100"
                  onClick={() => onClose(i)}
                />
              </span>
            )
          })}
        </div>
        <OverflowMenu
          side="left"
          indices={offscreen.left}
          tabs={tabs}
          marks={marks}
          agents={agents}
          onReveal={reveal}
        />
        <OverflowMenu
          side="right"
          indices={offscreen.right}
          tabs={tabs}
          marks={marks}
          agents={agents}
          onReveal={reveal}
        />
      </div>
      {trailing}
    </div>
  )
}
