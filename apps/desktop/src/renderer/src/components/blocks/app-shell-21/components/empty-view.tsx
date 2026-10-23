import { useMemo } from "react"
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
import { relativeTime } from "@/lib/relative-time"
import { nowAtom, todayAtom } from "@/state/clock"
import { ensureTodaysDailyAtom } from "@/state/daily"
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
export const NEW_TAB_PREFIX = "new-tab:"

export function isNewTab(id: string | null): boolean {
  return id !== null && id.startsWith(NEW_TAB_PREFIX)
}

/** How many recently edited documents the view lists. */
const RECENT_COUNT = 5

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
 * next, and what was written most recently. A still light from the top-left
 * corner (index.css, Desk) carries the sign-in's light into the shell; the
 * text stays clear of it.
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

  const vaultName =
    vaults.find((vault) => vault.remote === remote)?.name ?? remote

  async function openToday() {
    try {
      const path = await ensureDaily()
      if (path !== null) onOpen(path)
    } catch {
      toast.error(
        "Couldn't open today's note. Check that the vault is reachable, then try again."
      )
    }
  }

  return (
    <div
      data-slot="empty-view"
      className="relative isolate flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div
        aria-hidden="true"
        data-slot="desk-light"
        className="pointer-events-none absolute inset-0 -z-10"
      />
      {/* Sits a little above the middle, where the eye lands first. */}
      <div className="m-auto flex w-full max-w-md flex-col gap-8 px-4 pt-12 pb-24 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:slide-in-from-bottom-0">
        <header className="flex flex-col gap-1 px-2.5">
          {vaultName ? (
            <p className="text-muted-foreground text-xs font-medium">
              {vaultName}
            </p>
          ) : null}
          <h1 className="text-2xl font-semibold tracking-tight">
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

        <ItemGroup
          aria-label="Start"
          className="gap-0.5 has-data-[size=xs]:gap-0.5"
        >
          <StartRow
            icon={<FilePlusIcon />}
            label="New document"
            onClick={onNewDocument}
          />
          <StartRow
            icon={<CalendarDaysIcon />}
            label="Today's note"
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

        <RecentlyEdited onOpen={onOpen} onNewDocument={onNewDocument} />
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
          <ItemContent>
            <ItemTitle className="font-normal">{label}</ItemTitle>
          </ItemContent>
          {count ? (
            <ItemActions className="text-muted-foreground text-xs tabular-nums">
              {count}
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

  const recent = useMemo(
    () =>
      snapshot.docs
        .filter((doc) => !isHiddenPath(doc.path))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, RECENT_COUNT),
    [snapshot.docs]
  )

  return (
    <section aria-labelledby="recently-edited" className="flex flex-col gap-2">
      <h2
        id="recently-edited"
        className="text-muted-foreground px-2.5 text-xs font-medium"
      >
        Recently edited
      </h2>
      {!loaded ? (
        <div
          role="status"
          aria-label="Loading recent documents"
          className="flex flex-col gap-1"
        >
          {Array.from({ length: 3 }, (_, row) => (
            <Skeleton key={row} className="h-11 motion-reduce:animate-none" />
          ))}
        </div>
      ) : recent.length === 0 ? (
        <div className="flex flex-col items-start gap-3 px-2.5">
          <p className="text-muted-foreground text-sm">
            Nothing written in this vault yet.
          </p>
          <Button variant="outline" size="sm" onClick={onNewDocument}>
            <FilePlusIcon aria-hidden="true" />
            New document
          </Button>
        </div>
      ) : (
        <ItemGroup className="gap-0.5 has-data-[size=xs]:gap-0.5">
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
          <ItemContent className="min-w-0 gap-0.5">
            <ItemTitle className="block w-full truncate font-normal">
              {name}
            </ItemTitle>
            <ItemDescription className="truncate">
              {folder ? `${folder} · ${when}` : when}
            </ItemDescription>
          </ItemContent>
        </button>
      </Item>
    </div>
  )
}
