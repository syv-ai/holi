import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { ArrowDownIcon, ChevronRightIcon, ScrollTextIcon } from "lucide-react"

import { Badge } from "@/components/reui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"
import {
  activityEntriesAtom,
  activityFilterAtom,
  activityLoadAtom,
  clockTime,
  filterEntries,
  markActivitySeenAtom,
  type ActivityEntry,
} from "@/state/activity"

/**
 * The bottom panel's Output (docs/features/status-bar.md): what Holi did in
 * the background, a line each, newest at the foot.
 *
 * It follows the foot as lines arrive unless the person has scrolled up to
 * read, and then offers Jump to latest. Seeing it marks its errors seen, so
 * the status bar's dot goes out.
 */

/** Within this of the foot counts as at it: a fractional scroll position
 *  must not stop the follow. */
const FOOT_SLACK_PX = 24

type BadgeVariant =
  | "info-light"
  | "destructive-light"
  | "warning-light"
  | "primary-light"
  | "invert-light"

/** A line's badge: its level when that is news, else its channel's. */
export function badgeFor(entry: ActivityEntry): BadgeVariant {
  if (entry.level === "error") return "destructive-light"
  if (entry.level === "warn") return "warning-light"
  if (entry.channel === "git" || entry.channel === "sync") return "info-light"
  if (entry.channel === "agent") return "primary-light"
  return "invert-light"
}

export function PanelOutput({
  visible,
  onRetry,
}: {
  /** On screen: the panel open on Output. */
  visible: boolean
  onRetry: () => void
}) {
  const all = useAtomValue(activityEntriesAtom)
  const load = useAtomValue(activityLoadAtom)
  const filter = useAtomValue(activityFilterAtom)
  const markSeen = useSetAtom(markActivitySeenAtom)
  const entries = filterEntries(all, filter)
  const scroller = useRef<HTMLDivElement | null>(null)
  /** Following the foot: true until the person scrolls up. */
  const [following, setFollowing] = useState(true)
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set())

  useEffect(() => {
    if (visible) markSeen()
  }, [visible, all, markSeen])

  // Before paint, so a new line never shows a frame above the foot.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && visible && following) el.scrollTop = el.scrollHeight
  }, [entries, visible, following])

  function onScroll() {
    const el = scroller.current
    if (!el) return
    setFollowing(
      el.scrollHeight - el.scrollTop - el.clientHeight <= FOOT_SLACK_PX
    )
  }

  function jumpToLatest() {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    setFollowing(true)
  }

  function toggle(id: number) {
    setOpen((was) => {
      const next = new Set(was)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (load === "loading" && all.length === 0) {
    return (
      <div
        role="status"
        aria-label="Loading the output"
        className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2"
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    )
  }

  if (load === "error" && all.length === 0) {
    return (
      <Empty role="alert" className="min-h-0 flex-1 gap-3 p-4">
        <EmptyHeader>
          <EmptyTitle className="text-sm">Could not load the output</EmptyTitle>
          <EmptyDescription className="text-xs">
            Holi did not answer with its background log.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  if (entries.length === 0) {
    return (
      <Empty className="min-h-0 flex-1 gap-3 p-4">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ScrollTextIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="text-sm">
            {all.length === 0
              ? "Nothing has happened in the background yet"
              : "Nothing on this channel yet"}
          </EmptyTitle>
          <EmptyDescription className="text-xs">
            Commits, pulls, pushes and sync changes appear here as Holi makes
            them. Edit a document and its autosave lands in a few seconds.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-label="Output"
        aria-live="polite"
        className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs"
      >
        {entries.map((entry) => {
          const expanded = open.has(entry.id)
          const hasDetail = entry.detail !== undefined
          return (
            <div key={entry.id} data-entry={entry.id} className="flex flex-col">
              <button
                type="button"
                disabled={!hasDetail}
                aria-expanded={hasDetail ? expanded : undefined}
                onClick={() => toggle(entry.id)}
                className="hover:bg-muted/60 flex w-full min-w-0 items-center gap-2 px-3 py-0.5 text-start transition-colors disabled:cursor-default disabled:hover:bg-transparent"
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "text-muted-foreground size-3 shrink-0 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                    expanded && "rotate-90",
                    !hasDetail && "invisible"
                  )}
                />
                <time
                  dateTime={entry.at}
                  className="text-muted-foreground shrink-0 tabular-nums"
                >
                  {clockTime(entry.at)}
                </time>
                <Badge variant={badgeFor(entry)} className="shrink-0 font-sans">
                  {entry.channel}
                </Badge>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    entry.level === "error" && "text-destructive"
                  )}
                >
                  {entry.message}
                </span>
              </button>
              {expanded && hasDetail ? (
                <pre className="text-muted-foreground ms-9 me-3 mb-1 overflow-x-auto border-s ps-3 whitespace-pre-wrap">
                  {entry.detail}
                </pre>
              ) : null}
            </div>
          )
        })}
      </div>
      {following ? null : (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          onClick={jumpToLatest}
          className="absolute end-4 bottom-3"
        >
          <ArrowDownIcon data-icon="inline-start" aria-hidden />
          Jump to latest
        </Button>
      )}
    </div>
  )
}
