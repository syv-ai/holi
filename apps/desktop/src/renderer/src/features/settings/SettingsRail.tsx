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
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/primitives'
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
              {section.headings.length > 0 ? (
                <ChevronRight
                  size={12}
                  aria-hidden="true"
                  className={cn('shrink-0 transition-transform', active && 'rotate-90')}
                />
              ) : (
                // Keeps every label on one x-position whether or not its section
                // has children, so the rail does not look ragged.
                <span aria-hidden="true" className="w-3 shrink-0" />
              )}
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
