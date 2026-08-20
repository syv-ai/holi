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
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
import type { Tab } from '@/state/panes'

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

function tabIcon(tab: Tab): ReactNode {
  if (tab.kind === 'note') return fileIconFor(tab.path)
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
  trailing,
}: TabStripProps) {
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
  }, [tabs, widths, available, active])

  const window_ = tabWindow({
    widths: tabs.map((t) => widths[tabKey(t)] ?? 0),
    available,
    active,
    overflowWidth: OVERFLOW_WIDTH,
    gap: GAP,
  })
  const shown = tabs.slice(window_.start, window_.end)
  const hiddenTabs = [
    ...tabs.slice(0, window_.start).map((tab, i) => ({ tab, index: i })),
    ...tabs.slice(window_.end).map((tab, i) => ({ tab, index: window_.end + i })),
  ]

  return (
    <div className="flex h-11 min-w-0 items-center px-2">
      <div
        ref={hostRef}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
        data-testid="tab-strip"
      >
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
              className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs ${
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
                  className={`h-auto gap-1.5 p-0 hover:bg-transparent ${
                    t.kind === 'note' && t.preview ? 'italic' : ''
                  }`}
                  onClick={() => onSelect(i)}
                  onDoubleClick={() => onPin(i)}
                >
                  {tabIcon(t)}
                  <span>{tabName(t)}</span>
                </Button>
              </Tooltip>
              <Tooltip content="close tab">
                <Button
                  variant="ghost"
                  className="h-auto p-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
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
                  {tabIcon(tab)}
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
