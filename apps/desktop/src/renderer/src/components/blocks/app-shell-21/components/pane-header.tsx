import { Fragment } from "react"
import { useSetAtom } from "jotai"
import {
  EllipsisIcon,
  ReplaceIcon,
  SquareArrowOutUpRightIcon,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/cn"
import { shellWorkspaceAtom } from "@/state/shell-tabs"
import {
  closeTab,
  moveOut,
  replaceWithNew,
  type ShellWorkspace,
} from "@/state/shell-workspace"
import { parseTabKey, tabPath } from "@/state/tab-descriptor"

import { TabMark } from "./site-header"
import { useTabLook } from "./tab-look"
import { useTabDragSource } from "./use-tab-drag"

/**
 * Where a tab is, as its header says it: a document's or a vault app's
 * folders, then its name; any other tab just its title (a session's,
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
 * A split member's header (docs/features/tabs-panes.md, Split view): a
 * thin square row, the member's mark and where it is as a breadcrumb, then
 * its ⋯ (Replace with…, Move out of split, Close) and ×. Nothing tab-like:
 * the tabs live in the title band's strip. The focused member's title has
 * the foreground's full weight, the others' are muted. The header drags: to
 * the strip it leaves the split, onto another member it swaps or reorders.
 */
export function PaneHeader({
  member,
  focused,
}: {
  /** The member's tab key. */
  member: string
  focused: boolean
}) {
  const setWs = useSetAtom(shellWorkspaceAtom)
  const look = useTabLook()
  const drag = useTabDragSource()(member)
  const tab = look(member)
  const crumbs = tabCrumbs(member, tab.title)
  const blank = parseTabKey(member)?.kind === "new"
  const act = (change: (w: ShellWorkspace) => ShellWorkspace) => setWs(change)

  return (
    <div
      data-slot="pane-header"
      data-pane-focused={focused || undefined}
      {...drag}
      className={cn(
        "flex h-10 shrink-0 items-center gap-2 border-b px-3 transition-colors",
        focused ? "text-foreground" : "text-muted-foreground"
      )}
    >
      <TabMark tab={tab} />
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
            <BreadcrumbPage
              className={cn(
                "truncate font-medium transition-colors",
                !focused && "text-muted-foreground"
              )}
            >
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
                  aria-label="View options"
                >
                  <EllipsisIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>View options</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              disabled={blank}
              onSelect={() => act((w) => replaceWithNew(w, member))}
            >
              <ReplaceIcon aria-hidden="true" />
              Replace with…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act((w) => moveOut(w, member))}>
              <SquareArrowOutUpRightIcon aria-hidden="true" />
              Move out of split
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => act((w) => closeTab(w, member))}>
              <XIcon aria-hidden="true" />
              Close
              {focused ? <DropdownMenuShortcut>⌘W</DropdownMenuShortcut> : null}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Close ${tab.title}`}
              onClick={() => act((w) => closeTab(w, member))}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
