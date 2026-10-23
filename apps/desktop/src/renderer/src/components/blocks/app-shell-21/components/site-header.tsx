"use client"

import type { ReactNode } from "react"

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
import {
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  Columns2Icon,
  EllipsisVerticalIcon,
  FileTextIcon,
  PanelRightCloseIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react"

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

/** What a strip can do to its pane and to the panes beside it. Absent, the
 *  strip offers no pane actions (the phone's one column). */
export interface PaneControls {
  /** How many panes there are, and whether another fits. */
  count: number
  canSplit: boolean
  /** The pane is first or last, so a tab cannot move that way. */
  first: boolean
  last: boolean
  onSplitRight: (tabId?: string) => void
  onMoveTab: (tabId: string, side: "left" | "right") => void
  onClosePane: () => void
}

export function SiteHeader({
  tabs,
  activeTabId,
  focused = true,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onNewTab,
  onCloseAllTabs,
  onReopenTab,
  pane,
}: {
  tabs: HeaderTab[]
  activeTabId: string | null
  /** Whether this strip's pane is the focused one; an unfocused pane's
   *  active tab loses its weight. */
  focused?: boolean
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onCloseOtherTabs: (id: string) => void
  onNewTab: () => void
  onCloseAllTabs: () => void
  onReopenTab: () => void
  pane?: PaneControls
}) {
  return (
    // A row, not a landmark: the title band holds it with one pane, each
    // pane's header with several, and the mobile column's header on phones.
    <div
      data-slot="site-header"
      data-pane-focused={focused || undefined}
      className="group/strip flex h-full min-w-0 flex-1 items-center gap-2 px-2"
    >
      <Tabs
        value={activeTabId ?? ""}
        onValueChange={onSelectTab}
        className="min-w-0 flex-1 items-center gap-1 data-horizontal:flex-row"
      >
        {tabs.length > 0 ? (
          <TabsList
            variant="line"
            className="min-w-0 justify-start overflow-x-auto group-data-horizontal/tabs:h-9"
          >
            {tabs.map((tab) => (
              <ContextMenu key={tab.id}>
                <ContextMenuTrigger asChild>
                  {/* The close button is the trigger's sibling: a button
                      cannot hold another button. */}
                  <div
                    data-tab-key={tab.id}
                    className="group/tab relative flex h-full"
                  >
                    <TabsTrigger
                      value={tab.id}
                      aria-label={
                        tab.status === undefined
                          ? undefined
                          : `${tab.title}, ${STATUS_WORDS[tab.status]}`
                      }
                      className={cn(
                        "hover:bg-foreground/5 w-56 flex-none justify-start gap-2 rounded-md px-3 pe-8 after:hidden",
                        focused
                          ? "group-data-[variant=line]/tabs-list:data-active:bg-foreground/8 dark:group-data-[variant=line]/tabs-list:data-active:bg-foreground/8"
                          : "group-data-[variant=line]/tabs-list:data-active:bg-foreground/4 dark:group-data-[variant=line]/tabs-list:data-active:bg-foreground/4"
                      )}
                    >
                      <TabMark tab={tab} />
                      <span className="truncate">{tab.title}</span>
                    </TabsTrigger>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Close ${tab.title}`}
                      onClick={() => onCloseTab(tab.id)}
                      className="absolute end-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover/tab:opacity-100 group-has-data-active/tab:opacity-100 focus-visible:opacity-100"
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-56">
                  <ContextMenuItem onSelect={() => onCloseTab(tab.id)}>
                    <XIcon aria-hidden="true" />
                    Close
                    <ContextMenuShortcut>⌘W</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={tabs.length < 2}
                    onSelect={() => onCloseOtherTabs(tab.id)}
                  >
                    Close others
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={onCloseAllTabs}>
                    Close all
                    <ContextMenuShortcut>⌥⌘W</ContextMenuShortcut>
                  </ContextMenuItem>
                  {pane !== undefined ? (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        disabled={!pane.canSplit}
                        onSelect={() => pane.onSplitRight(tab.id)}
                      >
                        <Columns2Icon aria-hidden="true" />
                        Split right
                      </ContextMenuItem>
                      {pane.count > 1 ? (
                        <>
                          <ContextMenuItem
                            disabled={pane.first}
                            onSelect={() => pane.onMoveTab(tab.id, "left")}
                          >
                            <ArrowLeftToLineIcon aria-hidden="true" />
                            Move to left pane
                          </ContextMenuItem>
                          <ContextMenuItem
                            disabled={pane.last}
                            onSelect={() => pane.onMoveTab(tab.id, "right")}
                          >
                            <ArrowRightToLineIcon aria-hidden="true" />
                            Move to right pane
                          </ContextMenuItem>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={onReopenTab}>
                    <RotateCcwIcon aria-hidden="true" />
                    Reopen closed tab
                    <ContextMenuShortcut>⇧⌘T</ContextMenuShortcut>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
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
          {pane !== undefined ? (
            <>
              <DropdownMenuItem
                disabled={!pane.canSplit}
                onSelect={() => pane.onSplitRight()}
              >
                <Columns2Icon aria-hidden="true" />
                Split right
                <DropdownMenuShortcut>⌘\</DropdownMenuShortcut>
              </DropdownMenuItem>
              {pane.count > 1 ? (
                <DropdownMenuItem onSelect={pane.onClosePane}>
                  <PanelRightCloseIcon aria-hidden="true" />
                  Close pane
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem
            disabled={tabs.length === 0}
            onSelect={onCloseAllTabs}
          >
            <XIcon aria-hidden="true" />
            Close all tabs
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** The tab's mark, with a session's state as a dot on its corner. */
function TabMark({ tab }: { tab: HeaderTab }) {
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
