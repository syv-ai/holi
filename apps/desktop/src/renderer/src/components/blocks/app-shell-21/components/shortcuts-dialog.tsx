import { Fragment, useMemo, useRef, useState } from "react"
import { useAtom, useAtomValue } from "jotai"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { hotkeyLabels } from "@/lib/hotkey"
import {
  liveShortcuts,
  SHORTCUT_GROUPS,
  type ShortcutGroup,
  type ShortcutLine,
} from "@/lib/shortcuts"
import {
  isMac,
  liveShortcutIdsAtom,
  shortcutsDialogOpenAtom,
} from "@/state/shortcuts"
import { SearchIcon } from "lucide-react"

/** The live table, grouped, filtered by label, group or key name. */
export function shortcutSections(
  live: ReadonlySet<string>,
  query: string,
  mac: boolean
): { group: ShortcutGroup; lines: ShortcutLine[] }[] {
  const term = query.trim().toLowerCase()
  const lines = liveShortcuts(live)
  return SHORTCUT_GROUPS.flatMap((group) => {
    const inGroup = lines.filter((line) => {
      if (line.group !== group) return false
      if (term === "") return true
      const keys = line.specs.flatMap((spec) => hotkeyLabels(spec, mac))
      return [group, line.label, ...keys, line.gesture ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(term)
    })
    return inGroup.length > 0 ? [{ group, lines: inGroup }] : []
  })
}

function Keys({ specs, mac }: { specs: string[]; mac: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {specs.map((spec, index) => {
        const labels = hotkeyLabels(spec, mac)
        return (
          <Fragment key={spec}>
            {index > 0 ? (
              <span className="text-muted-foreground text-xs">or</span>
            ) : null}
            <KbdGroup aria-label={labels.join(" ")}>
              {labels.map((label) => (
                <Kbd key={label}>{label}</Kbd>
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
 * from (`lib/shortcuts.ts`). Opened from the profile menu, `?` or ⌘/.
 */
export function ShortcutsDialog() {
  const [open, setOpen] = useAtom(shortcutsDialogOpenAtom)
  const live = useAtomValue(liveShortcutIdsAtom)
  const [query, setQuery] = useState("")
  const searchRef = useRef<HTMLInputElement | null>(null)
  const mac = isMac()

  const sections = useMemo(
    () => shortcutSections(live, query, mac),
    [live, query, mac]
  )

  function handleOpenChange(next: boolean) {
    if (!next) setQuery("")
    setOpen(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
        }}
        className="gap-0 p-0 sm:max-w-2xl"
      >
        <DialogHeader className="gap-3 p-4 pb-3">
          <div className="flex flex-col gap-0.5">
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Keys that work in Holi right now.
            </DialogDescription>
          </div>
          <InputGroup>
            <InputGroupAddon align="inline-start">
              <InputGroupText>
                <SearchIcon aria-hidden="true" />
              </InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search shortcuts"
              aria-label="Search keyboard shortcuts"
              autoComplete="off"
            />
          </InputGroup>
        </DialogHeader>

        <ScrollArea className="max-h-[min(32rem,70svh)] min-h-0">
          {sections.length > 0 ? (
            <div className="grid gap-x-8 gap-y-6 px-4 pt-1 pb-5 sm:grid-cols-2">
              {sections.map(({ group, lines }) => (
                <section
                  key={group}
                  aria-labelledby={`shortcuts-${group}`}
                  className="flex flex-col gap-1"
                >
                  <h3
                    id={`shortcuts-${group}`}
                    className="text-muted-foreground text-xs font-medium"
                  >
                    {group}
                  </h3>
                  <div className="flex flex-col">
                    {lines.map((line) => (
                      <div
                        key={line.label}
                        className="flex min-w-0 items-center justify-between gap-4 py-1.5"
                      >
                        <span className="min-w-0 truncate text-sm">
                          {line.label}
                        </span>
                        {line.gesture === undefined ? (
                          <Keys specs={line.specs} mac={mac} />
                        ) : (
                          // A gesture (Split view's drags): its words, where
                          // a key's caps would be.
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {line.gesture}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <Empty className="border-0 py-10">
              <EmptyHeader>
                <EmptyTitle>No shortcuts found</EmptyTitle>
                <EmptyDescription>
                  Try an action, a section or a key name.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQuery("")
                    searchRef.current?.focus()
                  }}
                >
                  Clear search
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
