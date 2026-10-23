import { useEffect, useMemo, useRef, useState } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { toast } from "sonner"
import { isHiddenPath, type DocMeta } from "@holi/shared"
import {
  CalendarDaysIcon,
  FilePlusIcon,
  FileTextIcon,
  SearchIcon,
  SquareKanbanIcon,
} from "lucide-react"

import { AsciiWake } from "@/components/bencho/ASCIIWake"
import {
  ArcadeTakeControl,
  HoliArcade,
} from "@/components/monocode/arcade/HoliArcade"
import { Button } from "@/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"
import { relativeTime } from "@/lib/relative-time"
import { nowAtom, todayAtom } from "@/state/clock"
import { ensureTodaysDailyAtom } from "@/state/daily"
import { arcadeCastAtom, gridArcadeAtom } from "@/state/grid-arcade"
import { openTaskCountAtom, overdueTaskCountAtom } from "@/state/tasks"
import {
  activeRemoteAtom,
  snapshotAtom,
  snapshotLoadedAtom,
  vaultsAtom,
} from "@/state/vaults"

import { BOARD_TAB } from "./documents-section"

/** A tab opened with +: it shows this view until something is picked in it,
 *  and then becomes that thing. Nothing is written to the vault until then. */
export const NEW_TAB_PREFIX = "holi:new:"

export function isNewTab(id: string | null): boolean {
  return id !== null && id.startsWith(NEW_TAB_PREFIX)
}

/** How many recently edited documents the view lists when it is wide; a
 *  narrow one shows the first five. */
const RECENT_COUNT = 8

/** "Friday 23 October", from the clock's `YYYY-MM-DD`. */
const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
})

function dayLabel(today: string): string {
  const [year = 1970, month = 1, day = 1] = today.split("-").map(Number)
  return DAY.format(new Date(year, month - 1, day))
}

/**
 * What the view shows when nothing is open, or in a New tab: where you are
 * (the vault and the day), the board in one line, the few things you would do
 * next, and what was written most recently.
 *
 * Anchored to the top, not centred: a centred column would jump each time
 * the recent list changes length, the first load included.
 */
export function EmptyView({
  onOpen,
  onNewDocument,
  onOpenSearch,
}: {
  /** Open a vault path or the board, in place of a New tab. */
  onOpen: (id: string) => void
  onNewDocument: () => void
  onOpenSearch: () => void
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const vaults = useAtomValue(vaultsAtom)
  const today = useAtomValue(todayAtom)
  const openTasks = useAtomValue(openTaskCountAtom)
  const overdue = useAtomValue(overdueTaskCountAtom)
  const ensureDaily = useSetAtom(ensureTodaysDailyAtom)
  const arcadeOn = useAtomValue(gridArcadeAtom)
  const cast = useAtomValue(arcadeCastAtom)
  /** While someone plays, the board covers the pane and the content steps
   *  out; Escape or Release brings it back, focus on the take-control pill. */
  const [playing, setPlaying] = useState(false)
  /** The pointer is over the board's free ground, not over the content. */
  const [overBoard, setOverBoard] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const takeControlRef = useRef<HTMLButtonElement>(null)
  const wasPlaying = useRef(false)

  useEffect(() => {
    if (wasPlaying.current && !playing) takeControlRef.current?.focus()
    wasPlaying.current = playing
  }, [playing])

  /** Over the board when the pointer is on the scroller or the grid itself
   *  (the gaps between things), or on the take-control pill's own row. */
  function trackBoard(event: React.PointerEvent<HTMLDivElement>) {
    const target = event.target as Element
    const free =
      target === event.currentTarget ||
      target === gridRef.current ||
      target.closest("[data-arcade-free]") !== null
    if (free !== overBoard) setOverBoard(free)
  }

  const vaultName =
    vaults.find((vault) => vault.remote === remote)?.name ?? remote

  async function openToday() {
    try {
      const path = await ensureDaily()
      if (path !== null) onOpen(path)
    } catch {
      toast.error(
        "Couldn’t open today’s note. Check that the vault is reachable, then try again."
      )
    }
  }

  return (
    <div
      data-slot="empty-view"
      className="@container relative isolate flex min-h-0 flex-1 flex-col"
    >
      {/* The Holis' arcade, under everything and melting into the pane:
          content wins, so it takes no pointer until someone takes control,
          and then it covers the pane. The first of the fun to go as the
          pane narrows (below 48rem), before the logo; machine-local, on by
          default (`gridArcade`). */}
      {arcadeOn ? (
        <HoliArcade
          cast={cast}
          playing={playing}
          onRelease={() => setPlaying(false)}
          className="hidden @3xl:block"
        />
      ) : null}
      {/* The content scrolls over a board that stays put, and steps out
          while a game is on. */}
      <div
        data-slot="empty-view-content"
        inert={playing}
        aria-hidden={playing || undefined}
        onPointerMove={arcadeOn ? trackBoard : undefined}
        onPointerLeave={() => setOverBoard(false)}
        className={cn(
          "relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
          playing && "opacity-0"
        )}
      >
        {/* No entrance: a New tab opens many times a day, and opening a tab
          lands at once everywhere else in Holi. */}
        {/* Sized by the pane, not the window, since the sidebar takes its share:
          one column when narrow, and from 56rem the day across the top, the
          mark beside what you would do, and what was written across the foot. */}
        <div
          ref={gridRef}
          className="mx-auto grid w-full max-w-lg gap-10 px-6 pt-[max(3rem,12vh)] pb-16 @4xl:max-w-5xl @4xl:grid-cols-[auto_minmax(0,1fr)] @4xl:items-start @4xl:gap-x-16"
        >
          {/* The day heads the page, across both columns: where you are
            and what is open, before anything to do about it. */}
          <header className="flex flex-col gap-1 @4xl:col-span-2">
            {vaultName ? (
              <p className="text-muted-foreground text-xs font-medium">
                {vaultName}
              </p>
            ) : null}
            <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">
              {dayLabel(today)}
            </h1>
            <p className="text-muted-foreground text-sm">
              {openTasks === 0 ? (
                "Nothing open on the board."
              ) : (
                <>
                  <span className="text-foreground font-medium tabular-nums">
                    {openTasks}
                  </span>{" "}
                  open {openTasks === 1 ? "task" : "tasks"}
                  {overdue > 0 ? (
                    <>
                      ,{" "}
                      <span className="text-foreground font-medium tabular-nums">
                        {overdue}
                      </span>{" "}
                      overdue
                    </>
                  ) : null}
                  .
                </>
              )}
            </p>
          </header>

          {/* The mark, in dots the pointer drags a wake through: it moves only
            under the hand, so it costs nothing while the view is read. The
            first thing to go when the pane narrows. */}
          {/* The arcade keeps clear of it (`data-arcade-keepout`): the
            board dims to a whisper here and puts nothing on it, so the
            two sets of dots never fight. */}
          <div data-arcade-keepout="" className="hidden w-fit @xl:block">
            <AsciiWake shape="holi" size={8} label="Holi" />
          </div>

          {/* Commands as plain rows under a heading, the way an editor's
              welcome page lists them: the heading, not a fill, sets them
              apart from the documents. Kept to a short column, so Board's
              count stays beside it. */}
          <section
            aria-labelledby="start"
            className="flex flex-col gap-2 @4xl:max-w-sm"
          >
            <h2
              id="start"
              className="text-muted-foreground text-xs font-medium"
            >
              Start
            </h2>
            <ItemGroup className="gap-0.5 has-data-[size=xs]:gap-0.5">
              <StartRow
                icon={<FilePlusIcon />}
                label="New document"
                onClick={onNewDocument}
              />
              <StartRow
                icon={<CalendarDaysIcon />}
                label="Today’s note"
                onClick={() => void openToday()}
              />
              <StartRow
                icon={<SquareKanbanIcon />}
                label="Board"
                count={openTasks}
                onClick={() => onOpen(BOARD_TAB)}
              />
              <StartRow
                icon={<SearchIcon />}
                label="Search"
                onClick={onOpenSearch}
              />
            </ItemGroup>
          </section>

          <RecentlyEdited onOpen={onOpen} onNewDocument={onNewDocument} />

          {/* MonoCode's take-control pill, in the band under the content
              rather than over it, so it never covers a row: shown while the
              pointer is on the board's free ground, or on keyboard focus. */}
          {arcadeOn ? (
            <div
              data-arcade-free=""
              className="hidden justify-center py-2 @3xl:flex @4xl:col-span-2"
            >
              <ArcadeTakeControl
                ref={takeControlRef}
                show={overBoard}
                onClick={() => setPlaying(true)}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function StartRow({
  icon,
  label,
  count,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  /** A count at the row's end, left off when zero. */
  count?: number
  onClick: () => void
}) {
  return (
    // The group is a list; the row's button keeps its own role inside it.
    <div role="listitem">
      <Item
        asChild
        size="xs"
        className="hover:bg-foreground/5 focus-visible:bg-foreground/5 text-start"
      >
        <button type="button" onClick={onClick}>
          <ItemMedia
            variant="icon"
            aria-hidden="true"
            className="text-muted-foreground"
          >
            {icon}
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="block w-full truncate font-normal">
              {label}
            </ItemTitle>
          </ItemContent>
          {count ? (
            <ItemActions className="text-muted-foreground text-xs tabular-nums">
              {count}
              <span className="sr-only"> open tasks</span>
            </ItemActions>
          ) : null}
        </button>
      </Item>
    </div>
  )
}

/** The vault's newest documents by when the file last changed: the snapshot's
 *  own mtimes, so it is right on any machine, the first launch included. */
function RecentlyEdited({
  onOpen,
  onNewDocument,
}: {
  onOpen: (id: string) => void
  onNewDocument: () => void
}) {
  const snapshot = useAtomValue(snapshotAtom)
  const loaded = useAtomValue(snapshotLoadedAtom)
  const now = Date.parse(useAtomValue(nowAtom))
  /** Whether the rows replace a loading state: only then do they fade in,
   *  so the list does not swap in abruptly, and a vault already scanned
   *  shows it at once. */
  const arrived = useRef(!loaded).current

  const recent = useMemo(
    () =>
      snapshot.docs
        .filter((doc) => !isHiddenPath(doc.path))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, RECENT_COUNT),
    [snapshot.docs]
  )

  return (
    <section
      aria-labelledby="recently-edited"
      className="flex flex-col gap-2 @4xl:col-span-2"
    >
      <h2
        id="recently-edited"
        className="text-muted-foreground text-xs font-medium"
      >
        Recently edited
      </h2>
      {!loaded ? (
        <div
          role="status"
          aria-label="Loading recent documents"
          className="flex flex-col gap-0.5"
        >
          {/* The height of a real row, so nothing moves when the rows land. */}
          {Array.from({ length: 3 }, (_, row) => (
            <Skeleton key={row} className="h-9 motion-reduce:animate-none" />
          ))}
        </div>
      ) : recent.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground text-sm">
            Nothing written in this vault yet.
          </p>
          <Button variant="outline" size="sm" onClick={onNewDocument}>
            <FilePlusIcon aria-hidden="true" />
            New document
          </Button>
        </div>
      ) : (
        <ItemGroup
          className={cn(
            "gap-0.5 has-data-[size=xs]:gap-0.5",
            "[&>*:nth-child(n+6)]:hidden @4xl:[&>*:nth-child(n+6)]:block",
            arrived &&
              "animate-in fade-in-0 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
          )}
        >
          {recent.map((doc) => (
            <RecentRow key={doc.path} doc={doc} now={now} onOpen={onOpen} />
          ))}
        </ItemGroup>
      )}
    </section>
  )
}

function RecentRow({
  doc,
  now,
  onOpen,
}: {
  doc: DocMeta
  now: number
  onOpen: (id: string) => void
}) {
  const slash = doc.path.lastIndexOf("/")
  const name = doc.path.slice(slash + 1).replace(/\.md$/, "")
  const folder = slash === -1 ? null : doc.path.slice(0, slash)
  const when = relativeTime(doc.updatedAt, Number.isNaN(now) ? undefined : now)

  return (
    // The group is a list; the row's button keeps its own role inside it.
    <div role="listitem">
      <Item
        asChild
        size="xs"
        className="hover:bg-foreground/5 focus-visible:bg-foreground/5 text-start"
      >
        <button type="button" onClick={() => onOpen(doc.path)}>
          <ItemMedia
            variant="icon"
            aria-hidden="true"
            className="text-muted-foreground"
          >
            {doc.kind === "daily" ? <CalendarDaysIcon /> : <FileTextIcon />}
          </ItemMedia>
          {/* One line: the name leads, where it lives follows and gives way
              first, and when trails in its own column. */}
          <ItemContent className="min-w-0 flex-row items-baseline gap-2 group-data-[size=xs]/item:gap-2">
            <ItemTitle className="block min-w-0 shrink truncate font-normal">
              {name}
            </ItemTitle>
            {folder ? (
              <ItemDescription className="min-w-0 shrink-[4] truncate">
                {folder}
              </ItemDescription>
            ) : null}
          </ItemContent>
          <ItemActions className="text-muted-foreground text-xs tabular-nums">
            {when}
          </ItemActions>
        </button>
      </Item>
    </div>
  )
}
