/**
 * How a tab is named and marked, wherever it is listed: a pane's strip, and
 * the nav menu's section of open tabs (docs/features/tabs-panes.md). A file as
 * the tree names it, a surface tab by its surface.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  Tooltip,
} from '@/primitives'
import { cn } from '@/lib/cn'
import { surfaceLabel } from '@/lib/folder-documents'
import type { PathMark, Surface, SurfaceTabLook } from '@/plugin-api/types'
import { tabKey, type Tab } from '@/state/panes'
import { pathGlyph, pathLabel } from './file-icons'

/** What a vault file is marked with here and in the tree alike. `icons`
 *  is `.holi/settings/icons.yaml` as the snapshot resolved it, and `marks`
 *  what plugins mark paths with (a task's status), both keyed by
 *  vault-relative path. */
export interface PathMarks {
  icons: Record<string, string>
  marks: ReadonlyMap<string, PathMark>
}

/** The registry a surface tab is, and how the tabs of a surface that says
 *  (`Surface.tabs`) look now. */
export interface TabSources {
  surfaces: ReadonlyMap<string, Surface>
  looks: ReadonlyMap<string, ReadonlyMap<string, SurfaceTabLook>>
}

/** How a surface tab looks now, when its surface says. */
function lookOf(tab: Tab, sources: TabSources): SurfaceTabLook | null {
  if (tab.kind !== 'surface' || tab.id === undefined) return null
  return sources.looks.get(tab.surface)?.get(tab.id) ?? null
}

/** A note leads with nothing, as its tree row does; the pill keeps no empty
 *  slot, since nothing here lines up with it. */
export function tabIcon(tab: Tab, marks: PathMarks, sources: TabSources): ReactNode {
  if (tab.kind === 'note') {
    return pathGlyph(tab.path, {
      emoji: marks.icons[tab.path],
      mark: marks.marks.get(tab.path)?.glyph,
    })
  }
  // A dot its surface gives it (an agent session's state) stands in for
  // the surface's icon.
  const dot = lookOf(tab, sources)?.dot
  if (dot !== undefined) {
    return <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
  }
  const surface = sources.surfaces.get(tab.surface)
  if (surface === undefined) return null
  // A folder document (an app) wears the vault icon map's emoji, as its
  // tree row does.
  const emoji = tab.id === undefined ? undefined : marks.icons[tab.id]
  return emoji ? pathGlyph(tab.id!, { emoji }) : <Icon icon={surface.icon} size="sm" />
}

export function tabName(tab: Tab, sources: TabSources): string {
  if (tab.kind === 'note') return pathLabel(tab.path)
  const look = lookOf(tab, sources)
  if (look !== null) return look.label
  const surface = sources.surfaces.get(tab.surface)
  return surface === undefined ? tab.surface : surfaceLabel(surface, tab.id)
}

export function tabTooltip(tab: Tab, sources: TabSources): string {
  if (tab.kind === 'note') return tab.path
  const look = lookOf(tab, sources)
  if (look !== null) return look.tooltip ?? look.label
  const surface = sources.surfaces.get(tab.surface)
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
 * of blinking. The gradient keeps a pill scrolling beneath it legible. A
 * pane's strip and the dock's section of open tabs both have one per side.
 */
export function TabOverflowMenu({
  side,
  indices,
  surface = 'background',
  tabs,
  marks,
  sources,
  onReveal,
}: {
  side: 'left' | 'right'
  indices: number[]
  /** What the gradient fades from: what the tabs sit on. */
  surface?: 'background' | 'popover'
  tabs: Tab[]
  marks: PathMarks
  sources: TabSources
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
      } motion-respond ${
        surface === 'popover' ? 'from-popover' : 'from-background'
      } from-60% to-transparent ${visible ? 'opacity-100' : 'opacity-0'}`}
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
                {tabIcon(tab, marks, sources)}
                <span className={tab.kind === 'note' && tab.preview ? 'italic' : ''}>
                  {tabName(tab, sources)}
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
