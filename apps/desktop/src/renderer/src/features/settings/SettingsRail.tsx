/**
 * The settings tab's rail, drawn with the app's one tree (`primitives/Tree.tsx`):
 * sections are its top level, their headings the rows beneath.
 *
 * **Selection is expansion.** There is no separate open/closed state: clicking
 * a section shows it and opens its headings as jump links, so the one open
 * section is always the one you are in and the rail cannot disagree with the
 * content. The section in view wears the sidebar's current-row fill.
 *
 * The look is shared; the behaviour is not. The explorer's drag-and-drop,
 * rename, keys and menus are about the vault's files, and these are a few
 * static items one level deep: the tree instance's own arrow keys move between
 * them, and → on a section shows it.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { hotkeysCoreFeature, syncDataLoaderFeature } from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { cn } from '@/lib/cn'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tree,
  TreeItem,
  TreeItemLabel,
} from '@/primitives'
import type { SettingsSection } from './sections'

const ROOT = '__root__'
/** Ids are prefixed, because a section and a heading can share a name. */
const sectionKey = (id: string) => `s:${id}`
const headingKey = (id: string) => `h:${id}`

interface RailItem {
  name: string
  children: string[]
  /** The section, or the heading's id to jump to. */
  section?: SettingsSection
  heading?: string
}

export function SettingsRail({
  sections,
  activeId,
  onSelect,
  onJump,
}: {
  sections: readonly SettingsSection[]
  activeId: string
  /** Show this section. Always also expands it, since selection is expansion. */
  onSelect: (id: string) => void
  /** Scroll the section already on screen to one of its headings. */
  onJump: (headingId: string) => void
}): React.JSX.Element {
  /** The heading last jumped to in the open section, whose row is current. */
  const [jumped, setJumped] = useState<string | null>(null)
  useEffect(() => setJumped(null), [activeId])

  const items = useMemo(() => {
    const out: Record<string, RailItem> = {
      [ROOT]: { name: '', children: sections.map((s) => sectionKey(s.id)) },
    }
    for (const section of sections) {
      out[sectionKey(section.id)] = {
        name: section.label,
        section,
        children: section.headings.map((h) => headingKey(h.id)),
      }
      for (const h of section.headings)
        out[headingKey(h.id)] = { name: h.title, heading: h.id, children: [] }
    }
    return out
  }, [sections])
  const expandedItems = useMemo(() => [sectionKey(activeId)], [activeId])

  const tree = useTree<RailItem>({
    rootItemId: ROOT,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().children.length > 0,
    dataLoader: {
      getItem: (id) => items[id] ?? { name: '', children: [] },
      getChildren: (id) => items[id]?.children ?? [],
    },
    state: { expandedItems },
    // → on a closed section opens it, which is showing it.
    setExpandedItems: (next) => {
      const ids = typeof next === 'function' ? next(expandedItems) : next
      const opened = ids.find((id) => !expandedItems.includes(id))
      const section = opened === undefined ? undefined : items[opened]?.section
      if (section) onSelect(section.id)
    },
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  })

  return (
    <nav aria-label="Settings sections" className="flex flex-col px-2 py-3">
      <Tree tree={tree} indent={20} aria-label="Settings sections">
        {tree.getItems().map((item) => {
          const { section, heading } = item.getItemData()
          const current = section ? section.id === activeId : heading === jumped
          return (
            <TreeItem
              key={item.getId()}
              item={item}
              // `aria-current` rather than a selected state: this is navigation
              // within the tab, and the section is a location.
              aria-current={current ? 'true' : undefined}
              onClick={() => {
                item.setFocused()
                if (section) onSelect(section.id)
                else if (heading) {
                  setJumped(heading)
                  onJump(heading)
                }
              }}
              className="w-full"
            >
              <TreeItemLabel
                className={cn(
                  'min-w-0 text-muted-foreground hover:text-foreground',
                  // A section without headings has no chevron; its name still
                  // lines up with those that do.
                  current && 'bg-foreground/[0.06] text-foreground',
                )}
              >
                <span className="min-w-0 truncate">{item.getItemName()}</span>
              </TreeItemLabel>
            </TreeItem>
          )
        })}
      </Tree>
    </nav>
  )
}

/**
 * The rail, for a pane too narrow to hold one. Replaced rather than squeezed:
 * a 100px rail truncates every label, which is worse navigation than a picker.
 *
 * **It carries the headings too**: a narrow pane makes a section taller, so
 * jumps matter more here, not less.
 *
 * Values are prefixed rather than bare ids, because a section and a heading can
 * share a name.
 */
export function SettingsPicker({
  sections,
  activeId,
  onSelect,
  onJump,
}: {
  sections: readonly SettingsSection[]
  activeId: string
  onSelect: (id: string) => void
  onJump: (headingId: string) => void
}): React.JSX.Element {
  return (
    <Select
      // Never a stored value: choosing a heading is a scroll, not a selection,
      // so the control always reads as the section you are in.
      value={`s:${activeId}`}
      onValueChange={(value) => {
        const [kind, ...rest] = value.split(':')
        const id = rest.join(':')
        if (kind === 's') onSelect(id)
        else onJump(id)
      }}
    >
      <SelectTrigger size="sm" className="w-full" aria-label="Settings section">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {sections.map((section) => (
          <Fragment key={section.id}>
            <SelectItem value={`s:${section.id}`}>{section.label}</SelectItem>
            {section.id === activeId &&
              section.headings.map((h) => (
                <SelectItem key={h.id} value={`h:${h.id}`} className="pl-8 text-muted-foreground">
                  {h.title}
                </SelectItem>
              ))}
          </Fragment>
        ))}
      </SelectContent>
    </Select>
  )
}
