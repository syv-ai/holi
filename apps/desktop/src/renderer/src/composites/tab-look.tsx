/**
 * How a tab is named and marked, wherever it is listed: a pane's strip, and
 * the nav menu's cards of open tabs (docs/features/tabs-panes.md). A file as
 * the tree names it, a surface tab by its surface.
 */
import type { ReactNode } from 'react'
import type { TaskStatus } from '@holi/shared'
import { Icon } from '@/primitives'
import { cn } from '@/lib/cn'
import { surfaceLabel } from '@/lib/folder-documents'
import type { Surface, SurfaceTabLook } from '@/plugin-api/types'
import type { Tab } from '@/state/panes'
import { pathGlyph, pathLabel } from './file-icons'

/** A tab's stable identity, for React keys and for the pill-element map. */
export function tabKey(tab: Tab): string {
  return tab.kind === 'note' ? `note:${tab.path}` : `surface:${tab.surface}:${tab.id ?? ''}`
}

/** What a vault file is marked with here and in the tree alike. `icons`
 *  is `.holi/settings/icons.yaml` as the snapshot resolved it, and
 *  `tasks` each task file's status, both keyed by vault-relative path. */
export interface PathMarks {
  icons: Record<string, string>
  tasks: ReadonlyMap<string, TaskStatus>
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
    return pathGlyph(tab.path, { emoji: marks.icons[tab.path], task: marks.tasks.get(tab.path) })
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
