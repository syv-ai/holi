/**
 * The settings tab's rail: sections as folders, headings as their contents.
 *
 * **Selection is expansion.** There is no separate open/closed state, because a
 * section you are not looking at has nothing worth jumping to: clicking a
 * section shows its whole view and reveals its headings beneath it, muted, as
 * jump links into that view. So one section is open at a time and it is always
 * the one you are in, which means the rail can never disagree with the content.
 *
 * **Not `FileTree`, deliberately.** That is 829 lines of `@headless-tree` wiring
 * for drag-and-drop, multi-select, inline rename, hotkeys and context menus,
 * built as a projection of the vault snapshot. This is eight static items one
 * level deep with none of those gestures, and generalising the explorer would
 * have meant pulling headless-tree into a consumer that needs no part of it.
 * What the two genuinely share is the row's *look*, which is tokens.
 */
import { Fragment } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  Button,
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
              {/* **Always the chevron, hidden rather than swapped.** A
                  same-width spacer was not the same box: the button's
                  `[&_svg]` rules and the flex gap applied to one and not the
                  other, so a section with no headings sat 6px further right
                  than one with them — reading as though the plain entries were
                  children of the entry above. `invisible` keeps the identical
                  element, so they cannot drift again. */}
              <ChevronRight
                size={12}
                aria-hidden="true"
                className={cn(
                  'shrink-0 transition-transform',
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
 * The rail, for a pane too narrow to hold one.
 *
 * A pane's `minSize` is 240px, so the settings tab can be a third of the width
 * the rail plus a column of controls needs. Below the threshold the rail is
 * replaced by this rather than squeezed: a 100px rail truncates every label to
 * two words, which is a worse navigation than a picker.
 *
 * **It carries the headings too.** Losing the jump links here would be the
 * wrong way round — a narrow pane is not a shorter section, it is a taller one,
 * so a jump into the middle of Appearance matters more at this width than at
 * full width, not less. They appear under the section you are in, indented,
 * exactly as they do in the rail.
 *
 * Values are prefixed rather than bare ids, because a section and a heading can
 * legitimately share a name — Appearance's own list is a title away from it.
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
