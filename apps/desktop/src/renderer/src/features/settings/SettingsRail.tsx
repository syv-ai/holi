/**
 * The settings tab's rail: sections as folders, headings as their contents.
 *
 * **Selection is expansion.** There is no separate open/closed state: clicking
 * a section shows it and reveals its headings as jump links, so the one open
 * section is always the one you are in and the rail cannot disagree with the
 * content.
 *
 * **Not `FileTree`, deliberately.** That is the vault explorer, with
 * drag-and-drop, rename, keys and context menus over the snapshot; this is a
 * few static items one level deep. The two share only the row's look,
 * which is tokens.
 */
import { Fragment } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
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
  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-0.5 py-3">
      {sections.map((section) => {
        const active = section.id === activeId
        return (
          <div key={section.id}>
            <Button
              variant="ghost"
              size="xs"
              // `aria-current` rather than a pressed/selected role: this is
              // navigation within the tab, and the section is a location.
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(section.id)}
              className={cn(
                'h-7 w-full justify-start gap-1 rounded-none border-l-2 border-transparent px-3 text-xs font-normal',
                active && 'border-l-primary bg-accent font-medium text-foreground',
              )}
            >
              {/* **Always the chevron, hidden rather than swapped.** The
                  button pads itself differently when it holds an svg
                  (`has-[>svg]`), so a spacer in its place shifted the label,
                  and a plain entry read as a child of the one above.
                  `invisible` keeps the identical element. */}
              <Icon
                icon={ChevronRight}
                size="sm"
                className={cn(
                  'motion-respond',
                  section.headings.length === 0 && 'invisible',
                  active && 'rotate-90',
                )}
              />
              <span className="truncate">{section.label}</span>
            </Button>

            {active &&
              section.headings.map((h) => (
                <Button
                  key={h.id}
                  variant="ghost"
                  size="xs"
                  onClick={() => onJump(h.id)}
                  className="h-6 w-full justify-start rounded-none border-l-2 border-transparent py-0 pl-8 pr-3 text-[11px] font-normal text-muted-foreground hover:text-foreground"
                >
                  <span className="truncate">{h.title}</span>
                </Button>
              ))}
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
