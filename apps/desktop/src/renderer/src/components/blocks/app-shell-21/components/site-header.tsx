"use client"

import { Fragment, useState, type DragEvent, type ReactNode } from "react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import {
  Columns2Icon,
  EllipsisVerticalIcon,
  FileTextIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareSplitHorizontalIcon,
  UngroupIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/cn"
import type { IconGlyph } from "@/primitives"
import { shellWorkspaceAtom } from "@/state/shell-tabs"
import {
  activeSplit,
  closeAllTabs,
  closeEntry,
  closeOtherTabs,
  closeTabsToRight,
  dropOnStrip,
  entryId,
  focusMember,
  isSplit,
  MAX_SPLIT,
  openInSplit,
  reopenClosed,
  selectEntry,
  separate,
  splitActive,
  type ShellSplit,
  type ShellWorkspace,
} from "@/state/shell-workspace"

import { useTabLook } from "./tab-look"
import { TAB_MIME, tabDragAtom, useTabDragSource } from "./use-tab-drag"

export type HeaderTab = {
  id: string
  title: string
  /** A view's own glyph (Settings' cog); a page when absent. */
  icon?: IconGlyph
  /** Drawn in place of the glyph: a session's Claude mark or Holi face. */
  mark?: ReactNode
  /** A session's state, as a dot on the tab. */
  status?: "working" | "needs-you" | "done"
}

const STATUS_WORDS: Record<NonNullable<HeaderTab["status"]>, string> = {
  working: "working",
  "needs-you": "needs you",
  done: "done, not opened yet",
}

function spoken(tab: HeaderTab): string {
  return tab.status === undefined
    ? tab.title
    : `${tab.title}, ${STATUS_WORDS[tab.status]}`
}

/**
 * The one tab strip (docs/features/tabs-panes.md), in the title band always,
 * after Arc's: every entry, a split view among them as one pill holding its
 * members' marks and titles side by side. Clicking the pill selects the
 * split; clicking a member in it selects the split focused on that member.
 * Entries drag along the strip to reorder and onto the content to split
 * (`panes-view.tsx`), and a split member's header drags here to leave its
 * split. On the phone's one column nothing drags.
 */
export function SiteHeader({
  onNewTab,
  draggable = true,
}: {
  /** +, as the shell opens a New tab (or the Agents home). */
  onNewTab: () => void
  draggable?: boolean
}) {
  const [ws, setWs] = useAtom(shellWorkspaceAtom)
  const look = useTabLook()
  const dragSource = useTabDragSource()
  const dragged = useAtomValue(tabDragAtom)
  const setDrag = useSetAtom(tabDragAtom)
  /** Where a drag along the strip would land: before entry `n`. */
  const [dropAt, setDropAt] = useState<number | null>(null)
  const act = (change: (w: ShellWorkspace) => ShellWorkspace) => setWs(change)
  const split = activeSplit(ws)
  const count = ws.entries.length

  /** The insertion point under the pointer: before the first entry whose
   *  middle is right of it, else the end. */
  function indexAt(event: DragEvent<HTMLElement>): number {
    const items =
      event.currentTarget.querySelectorAll<HTMLElement>("[data-entry-id]")
    for (let i = 0; i < items.length; i += 1) {
      const rect = items[i]!.getBoundingClientRect()
      if (event.clientX < rect.left + rect.width / 2) return i
    }
    return items.length
  }

  /** Where a drag over the strip would land, or null when it would change
   *  nothing (an entry dropped where it is). */
  function stripDrop(event: DragEvent<HTMLElement>): number | null {
    if (!draggable || !event.dataTransfer.types.includes(TAB_MIME)) return null
    if (dragged === null) return null
    const at = indexAt(event)
    return dropOnStrip(ws, dragged, at) === ws ? null : at
  }

  return (
    // A row, not a landmark: the title band holds it on desktop, the mobile
    // column's header on phones.
    <div
      data-slot="site-header"
      className="group/strip flex h-full min-w-0 flex-1 items-center gap-2 px-2"
    >
      <Tabs
        value={ws.active ?? ""}
        onValueChange={(id) => act((w) => selectEntry(w, id))}
        className="min-w-0 flex-1 items-center gap-1 data-horizontal:flex-row"
      >
        {count > 0 ? (
          <TabsList
            variant="line"
            aria-label="Tabs"
            className="min-w-0 justify-start overflow-x-auto group-data-horizontal/tabs:h-9"
            onDragOver={(event) => {
              const at = stripDrop(event)
              if (at !== dropAt) setDropAt(at)
              if (at === null) return
              event.preventDefault()
              event.dataTransfer.dropEffect = "move"
            }}
            onDragLeave={(event) => {
              const to = event.relatedTarget
              if (!(to instanceof Node) || !event.currentTarget.contains(to)) {
                setDropAt(null)
              }
            }}
            onDrop={(event) => {
              const at = stripDrop(event)
              const key = event.dataTransfer.getData(TAB_MIME) || dragged
              setDropAt(null)
              setDrag(null)
              if (at === null || key === null) return
              event.preventDefault()
              act((w) => dropOnStrip(w, key, at))
            }}
          >
            {ws.entries.map((entry, index) => {
              const id = entryId(entry)
              const members = isSplit(entry) ? entry.views.map(look) : null
              const tab = members === null ? look(id) : null
              const label =
                tab !== null
                  ? spoken(tab)
                  : `Split view: ${members!.map(spoken).join(", ")}`
              return (
                <ContextMenu key={id}>
                  <ContextMenuTrigger asChild>
                    {/* The close button is the trigger's sibling: a button
                        cannot hold another button. */}
                    <div
                      data-entry-id={id}
                      data-tab-key={tab === null ? undefined : id}
                      data-drop-before={dropAt === index || undefined}
                      data-drop-after={
                        (dropAt === count && index === count - 1) || undefined
                      }
                      {...(draggable ? dragSource(id) : {})}
                      className={cn(
                        "group/tab relative flex h-full",
                        // Where a dragged entry would land: a hairline in
                        // the gap.
                        "data-drop-before:before:bg-primary data-drop-before:before:absolute data-drop-before:before:inset-y-1.5 data-drop-before:before:-start-0.5 data-drop-before:before:w-0.5 data-drop-before:before:rounded-full",
                        "data-drop-after:after:bg-primary data-drop-after:after:absolute data-drop-after:after:inset-y-1.5 data-drop-after:after:-end-0.5 data-drop-after:after:w-0.5 data-drop-after:after:rounded-full"
                      )}
                    >
                      <TabsTrigger
                        value={id}
                        aria-label={label}
                        onClick={(event) => {
                          // A member's part of the pill focuses that member.
                          const member = (event.target as HTMLElement)
                            .closest<HTMLElement>("[data-member]")
                            ?.getAttribute("data-member")
                          if (member) act((w) => focusMember(w, id, member))
                        }}
                        className={cn(
                          "hover:bg-foreground/5 flex-none justify-start gap-2 rounded-md px-3 pe-8 after:hidden",
                          "group-data-[variant=line]/tabs-list:data-active:bg-foreground/8 dark:group-data-[variant=line]/tabs-list:data-active:bg-foreground/8",
                          tab !== null
                            ? "w-56"
                            : members!.length > 2
                              ? "w-80"
                              : "w-64"
                        )}
                      >
                        {tab !== null ? (
                          <>
                            <TabMark tab={tab} />
                            <span className="truncate">{tab.title}</span>
                          </>
                        ) : (
                          <SplitMembers
                            members={members!}
                            focused={
                              split?.id === id
                                ? (entry as ShellSplit).focused
                                : null
                            }
                          />
                        )}
                      </TabsTrigger>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={
                          tab !== null
                            ? `Close ${tab.title}`
                            : "Close split view"
                        }
                        onClick={() => act((w) => closeEntry(w, id))}
                        className="absolute end-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover/tab:opacity-100 group-has-data-active/tab:opacity-100 focus-visible:opacity-100"
                      >
                        <XIcon aria-hidden="true" />
                      </Button>
                    </div>
                  </ContextMenuTrigger>
                  <EntryMenu
                    split={isSplit(entry) ? entry : null}
                    last={index === count - 1}
                    only={count < 2}
                    onOpenInSplit={() => act((w) => openInSplit(w, id))}
                    onSeparate={() => act((w) => separate(w, id))}
                    onClose={() => act((w) => closeEntry(w, id))}
                    onCloseOthers={() => act((w) => closeOtherTabs(w, id))}
                    onCloseRight={() => act((w) => closeTabsToRight(w, id))}
                    onReopen={() => act(reopenClosed)}
                  />
                </ContextMenu>
              )
            })}
          </TabsList>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New tab"
              onClick={onNewTab}
            >
              <PlusIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New tab</TooltipContent>
        </Tooltip>
      </Tabs>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Tab options">
            <EllipsisVerticalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            disabled={
              ws.active === null ||
              (split !== null && split.views.length >= MAX_SPLIT)
            }
            onSelect={() => act(splitActive)}
          >
            <Columns2Icon aria-hidden="true" />
            Split view
            <DropdownMenuShortcut>⌘\</DropdownMenuShortcut>
          </DropdownMenuItem>
          {split !== null ? (
            <DropdownMenuItem
              onSelect={() => act((w) => separate(w, split.id))}
            >
              <UngroupIcon aria-hidden="true" />
              Separate
              <DropdownMenuShortcut>⇧⌘\</DropdownMenuShortcut>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => act(reopenClosed)}>
            <RotateCcwIcon aria-hidden="true" />
            Reopen closed tab
            <DropdownMenuShortcut>⇧⌘T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={count === 0}
            onSelect={() => act(closeAllTabs)}
          >
            <XIcon aria-hidden="true" />
            Close all tabs
            <DropdownMenuShortcut>⌥⌘W</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** A split's pill inside: each member's mark and title, side by side and
 *  truncating evenly, a hairline between them. With the split active, the
 *  focused member's title has the full weight. */
function SplitMembers({
  members,
  focused,
}: {
  members: HeaderTab[]
  focused: string | null
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {members.map((member, at) => (
        <Fragment key={member.id}>
          {at > 0 ? (
            <span aria-hidden="true" className="bg-border h-4 w-px shrink-0" />
          ) : null}
          <span
            data-member={member.id}
            className={cn(
              "flex min-w-0 flex-1 basis-0 items-center gap-1.5 transition-colors",
              focused !== null &&
                focused !== member.id &&
                "text-muted-foreground"
            )}
          >
            <TabMark tab={member} />
            <span className="truncate">{member.title}</span>
          </span>
        </Fragment>
      ))}
    </span>
  )
}

/** A strip entry's right-click menu. */
function EntryMenu({
  split,
  last,
  only,
  onOpenInSplit,
  onSeparate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onReopen,
}: {
  split: ShellSplit | null
  last: boolean
  only: boolean
  onOpenInSplit: () => void
  onSeparate: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
  onReopen: () => void
}) {
  return (
    <ContextMenuContent className="w-56">
      {split === null ? (
        <ContextMenuItem onSelect={onOpenInSplit}>
          <SquareSplitHorizontalIcon aria-hidden="true" />
          Open in split view
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onSelect={onSeparate}>
          <UngroupIcon aria-hidden="true" />
          Separate
          <ContextMenuShortcut>⇧⌘\</ContextMenuShortcut>
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onClose}>
        <XIcon aria-hidden="true" />
        Close
      </ContextMenuItem>
      <ContextMenuItem disabled={only} onSelect={onCloseOthers}>
        Close others
      </ContextMenuItem>
      <ContextMenuItem disabled={last} onSelect={onCloseRight}>
        Close tabs to the right
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onReopen}>
        <RotateCcwIcon aria-hidden="true" />
        Reopen closed tab
        <ContextMenuShortcut>⇧⌘T</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** A tab's mark, with a session's state as a dot on its corner. */
export function TabMark({ tab }: { tab: HeaderTab }) {
  const Glyph = tab.icon ?? FileTextIcon
  return (
    <span className="relative flex shrink-0 items-center">
      {tab.mark ?? <Glyph aria-hidden={true} />}
      {tab.status !== undefined ? (
        <span
          aria-hidden="true"
          data-tab-status={tab.status}
          className={cn(
            "ring-background absolute -end-0.5 -top-0.5 size-1.5 rounded-full ring-2",
            tab.status === "working" &&
              "bg-info animate-pulse motion-reduce:animate-none",
            tab.status === "needs-you" && "bg-warning",
            tab.status === "done" && "bg-success"
          )}
        />
      ) : null}
    </span>
  )
}
