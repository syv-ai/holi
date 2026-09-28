/**
 * The settings tab's rail, in the file tree's system (`composites/tree.tsx`):
 * sections are its root headings, their headings the rows hung beneath.
 *
 * **Selection is expansion.** There is no separate open/closed state: clicking
 * a section shows it and opens its headings as jump links, so the one open
 * section is always the one you are in and the rail cannot disagree with the
 * content. The tree's bar marks it, and the way down to the heading last
 * jumped to is lit as the way to the open file is.
 *
 * The look is shared; the behaviour is not. The explorer's drag-and-drop,
 * rename, keys and menus are about the vault's files, and these are a few
 * static items one level deep.
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  TREE_LABEL,
  TREE_NESTED_ROW,
  TREE_ROOT_HANG,
  TREE_ROOT_ROW,
  TREE_ROW,
  TREE_ROW_RESET,
  TreeBar,
  TreeBranch,
  TreeDisclose,
  treeLead,
  treeNestedTone,
  treeRootTone,
} from '@/composites'
import {
  Button,
  Icon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/primitives'
import type { SettingsSection } from './sections'

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
  const nav = useRef<HTMLElement>(null)
  /** The heading last jumped to in the open section, whose way down is lit. */
  const [jumped, setJumped] = useState<string | null>(null)
  useEffect(() => setJumped(null), [activeId])

  return (
    <nav ref={nav} aria-label="Settings sections" className="relative flex flex-col py-3">
      <TreeBar
        container={nav}
        selector={`:scope > div > [data-section="${CSS.escape(activeId)}"]`}
        deps={[sections]}
      />
      {sections.map((section) => {
        const active = section.id === activeId
        const litIndex = active ? section.headings.findIndex((h) => h.id === jumped) : -1
        return (
          <div key={section.id}>
            <Button
              variant="ghost"
              data-section={section.id}
              // `aria-current` rather than a pressed/selected role: this is
              // navigation within the tab, and the section is a location.
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(section.id)}
              className={cn(TREE_ROW_RESET, TREE_ROOT_ROW, treeRootTone(active))}
            >
              {/* The chevron column, empty for a section with no headings so
                  the names still line up. */}
              <span className={treeLead(active)}>
                {section.headings.length > 0 && (
                  <Icon
                    icon={ChevronRight}
                    size="sm"
                    className={cn('motion-respond', active && 'rotate-90')}
                  />
                )}
              </span>
              <span className={TREE_LABEL}>{section.label}</span>
            </Button>
            {section.headings.length > 0 && (
              <div style={{ marginLeft: TREE_ROOT_HANG }}>
                <TreeDisclose open={active}>
                  <div className="relative py-1">
                    {section.headings.map((h, i) => (
                      <TreeBranch
                        key={h.id}
                        last={i === section.headings.length - 1}
                        lit={i === litIndex}
                        litThrough={litIndex > i}
                      >
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setJumped(h.id)
                            onJump(h.id)
                          }}
                          className={cn(
                            TREE_ROW_RESET,
                            TREE_NESTED_ROW,
                            treeNestedTone(h.id === jumped, i <= litIndex),
                          )}
                          style={{ height: TREE_ROW }}
                        >
                          <span className={TREE_LABEL}>{h.title}</span>
                        </Button>
                      </TreeBranch>
                    ))}
                  </div>
                </TreeDisclose>
              </div>
            )}
          </div>
        )
      })}
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
