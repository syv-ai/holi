import { Fragment } from "react"
import { useAtom } from "jotai"
import {
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  Columns2Icon,
  EllipsisIcon,
  FileTextIcon,
  ListXIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareSplitHorizontalIcon,
  XIcon,
} from "lucide-react"

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
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
import { shellWorkspaceAtom } from "@/state/shell-tabs"
import {
  closeOtherTabs,
  closePane,
  closeTab,
  MAX_PANES,
  moveTab,
  openInSplit,
  paneBeside,
  reopenClosed,
  selectTab,
  splitRight,
  type ShellWorkspace,
} from "@/state/shell-workspace"
import { tabPath } from "@/state/tab-descriptor"

import type { HeaderTab } from "./site-header"
import { useTabLook } from "./tab-look"
import { useTabDragSource } from "./use-tab-drag"

/**
 * Where a tab is, as its card's header says it: a document's or a vault
 * app's folders, then its name; any other tab just its title (a session's,
 * "Board", an app's name). Past two folders the middle ones fold into an
 * ellipsis.
 */
export function tabCrumbs(
  key: string | null,
  title: string
): { folders: (string | null)[]; name: string } {
  const path = tabPath(key)
  const folders = path === null ? [] : path.split("/").slice(0, -1)
  return {
    folders:
      folders.length > 2
        ? [folders[0]!, null, folders[folders.length - 1]!]
        : folders,
    name: title,
  }
}

/**
 * A split card's header (docs/features/tabs-panes.md, Split view): the
 * pane's own tabs as compact marks, its active tab's place as a muted
 * breadcrumb, then the pane's menu and its close. Closing the pane closes
 * its tabs, each one reopenable as a closed tab is.
 */
export function PaneHeader({
  paneId,
  onNewTab,
}: {
  paneId: string
  /** + in this pane, as the shell opens a New tab (or the Agents home). */
  onNewTab: () => void
}) {
  const [ws, setWs] = useAtom(shellWorkspaceAtom)
  const look = useTabLook()
  const index = ws.panes.findIndex((p) => p.id === paneId)
  const pane = ws.panes[index]
  if (pane === undefined) return null
  const focused = ws.focused === paneId
  const tabs = pane.tabs.map(look)
  const active = tabs.find((tab) => tab.id === pane.active) ?? null
  const crumbs = tabCrumbs(pane.active, active?.title ?? "Empty pane")
  const canSplit = ws.panes.length < MAX_PANES
  const left = paneBeside(ws, paneId, "left")
  const right = paneBeside(ws, paneId, "right")
  const act = (change: (w: ShellWorkspace) => ShellWorkspace) => setWs(change)

  return (
    <div
      data-slot="pane-header"
      data-pane-focused={focused || undefined}
      className="flex h-10 shrink-0 items-center gap-2 border-b px-2"
    >
      <Tabs
        value={pane.active ?? ""}
        onValueChange={(key) => act((w) => selectTab(w, paneId, key))}
        className="shrink-0 items-center gap-1 data-horizontal:flex-row"
      >
        {tabs.length > 0 ? (
          <TabsList variant="line" aria-label="Tabs in this pane">
            {tabs.map((tab) => (
              <PaneTab
                key={tab.id}
                tab={tab}
                focused={focused}
                count={tabs.length}
                left={left !== null}
                right={right !== null}
                onClose={() => act((w) => closeTab(w, tab.id))}
                onCloseOthers={() => act((w) => closeOtherTabs(w, tab.id))}
                onOpenInSplit={() => act((w) => openInSplit(w, tab.id))}
                onMove={(side) =>
                  act((w) => {
                    const to = paneBeside(w, paneId, side)
                    return to === null ? w : moveTab(w, tab.id, to.id)
                  })
                }
                onReopen={() => act(reopenClosed)}
              />
            ))}
          </TabsList>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="New tab"
              onClick={onNewTab}
            >
              <PlusIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New tab</TooltipContent>
        </Tooltip>
      </Tabs>

      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          {crumbs.folders.map((folder, at) => (
            <Fragment key={`${at}:${folder ?? "…"}`}>
              <BreadcrumbItem className="min-w-0 shrink">
                {folder === null ? (
                  <BreadcrumbEllipsis />
                ) : (
                  <span className="truncate">{folder}</span>
                )}
              </BreadcrumbItem>
              <BreadcrumbSeparator />
            </Fragment>
          ))}
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="truncate font-medium">
              {crumbs.name}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex shrink-0 items-center gap-1">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Pane options"
                >
                  <EllipsisIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Pane options</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              disabled={!canSplit}
              onSelect={() => act((w) => splitRight(w, paneId))}
            >
              <Columns2Icon aria-hidden="true" />
              Split right
              <DropdownMenuShortcut>⌘\</DropdownMenuShortcut>
            </DropdownMenuItem>
            {left !== null ? (
              <DropdownMenuItem
                disabled={pane.active === null}
                onSelect={() =>
                  act((w) =>
                    pane.active === null ? w : moveTab(w, pane.active, left.id)
                  )
                }
              >
                <ArrowLeftToLineIcon aria-hidden="true" />
                Move tab to left pane
              </DropdownMenuItem>
            ) : null}
            {right !== null ? (
              <DropdownMenuItem
                disabled={pane.active === null}
                onSelect={() =>
                  act((w) =>
                    pane.active === null ? w : moveTab(w, pane.active, right.id)
                  )
                }
              >
                <ArrowRightToLineIcon aria-hidden="true" />
                Move tab to right pane
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              disabled={pane.active === null || tabs.length < 2}
              onSelect={() =>
                act((w) =>
                  pane.active === null ? w : closeOtherTabs(w, pane.active)
                )
              }
            >
              <ListXIcon aria-hidden="true" />
              Close other tabs
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => act(reopenClosed)}>
              <RotateCcwIcon aria-hidden="true" />
              Reopen closed tab
              <DropdownMenuShortcut>⇧⌘T</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close pane"
              onClick={() => act((w) => closePane(w, paneId))}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close pane</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

/** One tab of a card's strip: its mark, named by its title, draggable to
 *  another card or a card's edge, with the tab's menu on right-click. */
function PaneTab({
  tab,
  focused,
  count,
  left,
  right,
  onClose,
  onCloseOthers,
  onOpenInSplit,
  onMove,
  onReopen,
}: {
  tab: HeaderTab
  focused: boolean
  count: number
  left: boolean
  right: boolean
  onClose: () => void
  onCloseOthers: () => void
  onOpenInSplit: () => void
  onMove: (side: "left" | "right") => void
  onReopen: () => void
}) {
  const drag = useTabDragSource()(tab.id)
  const Glyph = tab.icon ?? FileTextIcon
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <TabsTrigger
              value={tab.id}
              aria-label={tab.title}
              data-tab-key={tab.id}
              {...drag}
              onAuxClick={(event) => {
                // A middle click closes, as in a browser.
                if (event.button === 1) onClose()
              }}
              className={cn(
                "hover:bg-foreground/5 relative flex-none after:hidden",
                focused
                  ? "group-data-[variant=line]/tabs-list:data-active:bg-foreground/8 dark:group-data-[variant=line]/tabs-list:data-active:bg-foreground/8"
                  : "group-data-[variant=line]/tabs-list:data-active:bg-foreground/4 dark:group-data-[variant=line]/tabs-list:data-active:bg-foreground/4"
              )}
            >
              {tab.mark ?? <Glyph aria-hidden={true} />}
              {tab.status !== undefined ? (
                <span
                  aria-hidden="true"
                  data-tab-status={tab.status}
                  className={cn(
                    "ring-background absolute end-0.5 top-0.5 size-1.5 rounded-full ring-2",
                    tab.status === "working" &&
                      "bg-info animate-pulse motion-reduce:animate-none",
                    tab.status === "needs-you" && "bg-warning",
                    tab.status === "done" && "bg-success"
                  )}
                />
              ) : null}
            </TabsTrigger>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent>{tab.title}</TooltipContent>
      </Tooltip>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={onClose}>
          <XIcon aria-hidden="true" />
          Close
          <ContextMenuShortcut>⌘W</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={count < 2} onSelect={onCloseOthers}>
          Close others
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onOpenInSplit}>
          <SquareSplitHorizontalIcon aria-hidden="true" />
          Open in split view
        </ContextMenuItem>
        <ContextMenuItem disabled={!left} onSelect={() => onMove("left")}>
          <ArrowLeftToLineIcon aria-hidden="true" />
          Move to left pane
        </ContextMenuItem>
        <ContextMenuItem disabled={!right} onSelect={() => onMove("right")}>
          <ArrowRightToLineIcon aria-hidden="true" />
          Move to right pane
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onReopen}>
          <RotateCcwIcon aria-hidden="true" />
          Reopen closed tab
          <ContextMenuShortcut>⇧⌘T</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
