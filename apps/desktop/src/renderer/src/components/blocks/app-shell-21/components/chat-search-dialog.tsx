"use client"

import { useMemo, useState } from "react"
import { cn } from "@/lib/cn"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { type ThreadRecord } from "./data"
import { MessageSquareIcon, SearchIcon } from "lucide-react"

function ResultRow({
  thread,
  onSelect,
}: {
  thread: ThreadRecord
  onSelect: (id: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(thread.id)}
        className="hover:bg-accent focus-visible:bg-accent group/row flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-start transition-colors outline-none"
      >
        <MessageSquareIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm">{thread.title}</span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums group-hover/row:hidden">
          {thread.updatedLabel}
        </span>
        <Kbd className="hidden group-hover/row:inline-flex">Enter</Kbd>
      </button>
    </li>
  )
}

export function ChatSearchDialog({
  open,
  onOpenChange,
  threads,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  threads: ThreadRecord[]
  onSelect: (id: string) => void
}) {
  const [query, setQuery] = useState("")

  const { pinned, recent } = useMemo(() => {
    const term = query.trim().toLowerCase()
    const matched = term
      ? threads.filter((thread) => thread.title.toLowerCase().includes(term))
      : threads
    return {
      pinned: matched.filter((thread) => thread.pinned),
      recent: matched.filter((thread) => !thread.pinned),
    }
  }, [query, threads])

  const empty = pinned.length + recent.length === 0
  const firstMatch = pinned[0] ?? recent[0]

  function choose(id: string) {
    onSelect(id)
    setQuery("")
    onOpenChange(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) setQuery("")
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* No close button: it would sit inside the search field, and Escape or
          the overlay already dismiss the palette. */}
      <DialogContent
        showCloseButton={false}
        className="top-[18%] max-w-xl translate-y-0 gap-0 p-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search chats</DialogTitle>
          <DialogDescription>Find a conversation by title.</DialogDescription>
        </DialogHeader>

        <div className="p-2">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon className="text-muted-foreground" aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Enter opens the top result, the palette convention.
                if (event.key !== "Enter" || !firstMatch) return
                event.preventDefault()
                choose(firstMatch.id)
              }}
              placeholder="Search chats and projects"
              aria-label="Search chats and projects"
            />
          </InputGroup>
        </div>

        {/* Results scroll so the dialog height never chases the list, and the
            scrollbar only appears while the pointer is in the panel. */}
        <ScrollArea
          className={cn(
            "max-h-96 min-h-0 p-2",
            // Radix wraps viewport children in a display:table div, which
            // breaks the rows' truncate. Targets that wrapper only.
            "[&>[data-slot=scroll-area-viewport]>div]:block!",
            "[&_[data-slot=scroll-area-scrollbar]]:opacity-0 [&_[data-slot=scroll-area-scrollbar]]:transition-opacity [&_[data-slot=scroll-area-scrollbar]]:duration-150 hover:[&_[data-slot=scroll-area-scrollbar]]:opacity-100"
          )}
        >
          <p aria-live="polite" className="sr-only">
            {pinned.length + recent.length} results
          </p>

          {empty ? (
            <Empty className="border-0 bg-transparent py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No Matches</EmptyTitle>
                <EmptyDescription>
                  Try a different word from the chat title.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {pinned.length > 0 ? (
            <>
              <p className="text-muted-foreground px-2 py-1.5 text-xs">
                Pinned
              </p>
              <ul className="flex flex-col">
                {pinned.map((thread) => (
                  <ResultRow
                    key={thread.id}
                    thread={thread}
                    onSelect={choose}
                  />
                ))}
              </ul>
            </>
          ) : null}

          {recent.length > 0 ? (
            <>
              <p className="text-muted-foreground px-2 py-1.5 text-xs">
                Recent
              </p>
              <ul className="flex flex-col">
                {recent.map((thread) => (
                  <ResultRow
                    key={thread.id}
                    thread={thread}
                    onSelect={choose}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}