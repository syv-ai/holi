import { Fragment, useMemo, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'

import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { hotkeyLabels } from '@/lib/hotkey'
import {
  liveShortcuts,
  SHORTCUT_GROUPS,
  type ShortcutGroup,
  type ShortcutLine,
} from '@/lib/shortcuts'
import {
  isMac,
  liveShortcutIdsAtom,
  runShortcutAtom,
  shortcutsDialogOpenAtom,
} from '@/state/shortcuts'
import { EmptyState } from '@/composites/empty-state'

/** The live table, grouped, filtered by label, group or key name. */
function shortcutSections(
  live: ReadonlySet<string>,
  query: string,
  mac: boolean,
): { group: ShortcutGroup; lines: ShortcutLine[] }[] {
  const term = query.trim().toLowerCase()
  const lines = liveShortcuts(live)
  return SHORTCUT_GROUPS.flatMap((group) => {
    const inGroup = lines.filter((line) => {
      if (line.group !== group) return false
      if (term === '') return true
      const keys = line.specs.flatMap((spec) => hotkeyLabels(spec, mac))
      return [group, line.label, ...keys, line.gesture ?? ''].join(' ').toLowerCase().includes(term)
    })
    return inGroup.length > 0 ? [{ group, lines: inGroup }] : []
  })
}

/** A line's keys in words for its accessible name: `⇧ ⌘ T or …`. */
function keysName(line: ShortcutLine, mac: boolean): string {
  if (line.gesture !== undefined) return line.gesture
  return line.specs.map((spec) => hotkeyLabels(spec, mac).join(' ')).join(' or ')
}

function Keys({ specs, mac }: { specs: string[]; mac: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {specs.map((spec, index) => {
        const labels = hotkeyLabels(spec, mac)
        return (
          <Fragment key={spec}>
            {index > 0 ? <span className="text-muted-foreground text-xs">or</span> : null}
            <KbdGroup>
              {labels.map((label) => (
                // The selected row is bg-muted, as a cap is: lift the cap.
                <Kbd key={label} className="group-data-selected/command-item:bg-background">
                  {label}
                </Kbd>
              ))}
            </KbdGroup>
          </Fragment>
        )
      })}
    </div>
  )
}

/**
 * Every shortcut that works right now, from the same table the keys run
 * from (`lib/shortcuts.ts`), and a command list over it: the arrows move,
 * Enter runs the row through the handler its key runs (`runShortcutAtom`).
 * Opened from the profile menu, `?` or ⌘/.
 */
export function ShortcutsDialog() {
  const [open, setOpen] = useAtom(shortcutsDialogOpenAtom)
  const live = useAtomValue(liveShortcutIdsAtom)
  const runShortcut = useSetAtom(runShortcutAtom)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)
  /** Where focus was when the dialog opened, to hand it back before a run. */
  const returnFocus = useRef<HTMLElement | null>(null)
  /** The row chosen, run once the dialog has closed. */
  const pending = useRef<string | null>(null)
  const mac = isMac()

  const sections = useMemo(() => shortcutSections(live, query, mac), [live, query, mac])

  function handleOpenChange(next: boolean) {
    if (!next) setQuery('')
    setOpen(next)
  }

  function choose(id: string) {
    pending.current = id
    handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          // Still the element focused before the dialog took focus.
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
          event.preventDefault()
          searchRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          // Radix would focus a trigger, and this dialog has none (it opens
          // from keys and the profile menu): hand focus back to where it
          // was, then run the chosen row, so whatever the action focuses
          // (a new tab, the terminal) keeps it.
          event.preventDefault()
          const back = returnFocus.current
          returnFocus.current = null
          if (back?.isConnected) back.focus()
          const id = pending.current
          pending.current = null
          if (id !== null) runShortcut(id)
        }}
        variant="flush"
        className="sm:max-w-lg"
      >
        <div className="flex flex-col gap-2 p-4 pb-2">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Keys that work in Holi right now. Choose one to run it.
          </DialogDescription>
        </div>

        {/* Filtered by `shortcutSections`, not cmdk's fuzzy match, so a
            search means the same thing it always has. */}
        <Command shouldFilter={false} label="Search keyboard shortcuts">
          <CommandInput
            ref={searchRef}
            value={query}
            onValueChange={setQuery}
            placeholder="Search shortcuts"
          />
          <CommandList label="Keyboard shortcuts">
            {sections.map(({ group, lines }) => (
              <CommandGroup key={group} heading={group}>
                {lines.map((line) => (
                  <CommandItem
                    key={line.label}
                    value={`${group}: ${line.label}`}
                    aria-label={`${line.label}, ${keysName(line, mac)}`}
                    // A gesture or a line only shown: skipped by the arrows.
                    disabled={line.run === undefined}
                    onSelect={() => {
                      if (line.run !== undefined) choose(line.run)
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{line.label}</span>
                    <CommandShortcut className="tracking-normal">
                      {line.gesture === undefined ? (
                        <Keys specs={line.specs} mac={mac} />
                      ) : (
                        // A gesture (Split view's drags): its words, where a
                        // key's caps would be.
                        line.gesture
                      )}
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          {sections.length === 0 ? (
            <EmptyState
              title="No shortcuts found"
              description="Try an action, a section or a key name."
              action={{
                label: 'Clear search',
                onClick: () => {
                  setQuery('')
                  searchRef.current?.focus()
                },
              }}
              className="h-auto"
            />
          ) : null}
        </Command>
      </DialogContent>
    </Dialog>
  )
}
