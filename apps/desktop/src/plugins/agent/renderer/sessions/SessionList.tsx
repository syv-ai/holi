/**
 * The Agents sidebar's session list (docs/features/agent-sessions.md, The
 * Agents view): every conversation and background run in one place, as
 * MonoCode's session cards draw them, under a "Search conversations…" field
 * with a filter menu.
 *
 * After MonoCode's `Sidebar.tsx` session list and card (MIT, Copyright (c)
 * 2026 Nick; see NOTICE.md): the provider's mark and the model with the age
 * on the right, the title, then where it runs. "A state worth noticing takes
 * the time's place": working spins, needs you is a badge and pins the row to
 * the top, done shows a check until the row is opened.
 */
import { SiClaude } from "@icons-pack/react-simple-icons"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import {
  CheckIcon,
  CircleAlertIcon,
  GitBranchIcon,
  ListFilterIcon,
  MessageSquarePlusIcon,
  PlusIcon,
  SearchIcon,
  ZapIcon,
} from "lucide-react"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from "react"
import { Badge } from "@/components/reui/badge"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PixelPersona } from "@/composites"
import { cn } from "@/plugin-api"
import { agentSessionsAtom } from "../state/sessions"
import {
  duplicateSessionAtom,
  respawnSessionAtom,
  stopSessionAtom,
} from "../state/send"
import {
  age,
  archivableOwnersAtom,
  archiveSessionRowAtom,
  filterActive,
  keyOwner,
  groupRows,
  modelLabel,
  newSessionAtom,
  NO_FILTER,
  openSessionRowAtom,
  reloadSessionsAtom,
  rowMatches,
  sessionFilterAtom,
  sessionQueryAtom,
  sessionRowsAtom,
  sessionsStatusAtom,
  sessionVaultNameAtom,
  type SessionFilter,
  type SessionRow,
  type SessionSource,
} from "../state/session-list"

/** "now" that moves, so the cards' ages stay true. */
function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), stepMs)
    return () => window.clearInterval(id)
  }, [stepMs])
  return now
}

const STATE_FILTERS: readonly {
  value: SessionFilter["states"][number]
  label: string
}[] = [
  { value: "needs-you", label: "Needs you" },
  { value: "working", label: "Working" },
  { value: "done", label: "Done" },
]

const SOURCES: readonly { value: SessionSource; label: string }[] = [
  { value: "all", label: "Anyone" },
  { value: "mine", label: "You" },
  { value: "agents", label: "Holis and automations" },
]

/** MonoCode's search field with its filter button, as a ReUI input group. */
export function SessionSearch(): React.JSX.Element {
  const [query, setQuery] = useAtom(sessionQueryAtom)
  const [filter, setFilter] = useAtom(sessionFilterAtom)
  const active = filterActive(filter)
  const toggleState = (value: SessionFilter["states"][number]) =>
    setFilter((f) => ({
      ...f,
      states: f.states.includes(value)
        ? f.states.filter((s) => s !== value)
        : [...f.states, value],
    }))
  return (
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        placeholder="Search conversations…"
        aria-label="Search conversations"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query !== "") {
            e.preventDefault()
            setQuery("")
          }
        }}
      />
      <InputGroupAddon align="inline-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <InputGroupButton
              size="icon-xs"
              aria-label={active ? "Filter, on" : "Filter"}
              data-filter-on={active ? "" : undefined}
              className={cn("relative", active && "text-foreground")}
            >
              <ListFilterIcon aria-hidden="true" />
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute end-0.5 top-0.5 size-1.5 rounded-full bg-primary"
                />
              )}
            </InputGroupButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>State</DropdownMenuLabel>
            {STATE_FILTERS.map((s) => (
              <DropdownMenuCheckboxItem
                key={s.value}
                checked={filter.states.includes(s.value)}
                onCheckedChange={() => toggleState(s.value)}
                onSelect={(e) => e.preventDefault()}
              >
                {s.label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Started by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filter.source}
              onValueChange={(v) =>
                setFilter((f) => ({ ...f, source: v as SessionSource }))
              }
            >
              {SOURCES.map((s) => (
                <DropdownMenuRadioItem
                  key={s.value}
                  value={s.value}
                  onSelect={(e) => e.preventDefault()}
                >
                  {s.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={filter.archived}
              onCheckedChange={(v) =>
                setFilter((f) => ({ ...f, archived: v === true }))
              }
              onSelect={(e) => e.preventDefault()}
            >
              Show archived
            </DropdownMenuCheckboxItem>
            {active && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setFilter(NO_FILTER)}>
                  Clear filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </InputGroupAddon>
    </InputGroup>
  )
}

/** The state or the age, right-aligned on the card's first line. */
function CardStatus({
  row,
  now,
}: {
  row: SessionRow
  now: number
}): React.JSX.Element {
  const { item, state } = row
  if (state === "needs-you") {
    const badge = (
      <Badge variant="warning-light">
        <CircleAlertIcon aria-hidden="true" />
        Needs you
      </Badge>
    )
    return item.waitingFor === undefined ? (
      badge
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="right">{item.waitingFor}</TooltipContent>
      </Tooltip>
    )
  }
  if (state === "working") {
    return (
      <span className="flex items-center gap-1 text-xs text-foreground">
        <Spinner
          aria-hidden="true"
          role="presentation"
          className="size-3 motion-reduce:animate-none"
        />
        Working
      </span>
    )
  }
  const when = age(item.endedAt ?? item.updatedAt, now)
  if (state === "done") {
    return (
      <span className="flex items-center gap-1 text-xs text-success-foreground tabular-nums">
        <CheckIcon aria-hidden="true" className="size-3" />
        <span className="sr-only">Done, not opened yet,</span>
        {when}
      </span>
    )
  }
  return (
    <span className="text-xs text-muted-foreground tabular-nums">{when}</span>
  )
}

/** The mark on the first line: the Holi's face when one ran it, the
 *  automation's bolt, else the provider's. */
function CardMark({ row }: { row: SessionRow }): React.JSX.Element {
  const by = row.item.by
  if (by?.kind === "holi" && by.mascot !== undefined) {
    return (
      <PixelPersona
        name={by.mascot}
        color={by.color ?? "#8f8f94"}
        status={row.state === "done" ? "idle" : row.state}
        still={row.state === "idle" || row.state === "done"}
        className="size-4"
      />
    )
  }
  if (by !== undefined) {
    return (
      <ZapIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
      />
    )
  }
  return (
    <SiClaude
      aria-hidden="true"
      className="size-3.5 shrink-0 text-orange-500 dark:text-orange-400"
    />
  )
}

function stateWords(row: SessionRow): string {
  switch (row.state) {
    case "needs-you":
      return row.item.waitingFor === undefined
        ? "needs you"
        : `needs you: ${row.item.waitingFor}`
    case "working":
      return "working"
    case "done":
      return "done, not opened yet"
    default:
      return ""
  }
}

/** A session as MonoCode's card draws one: model and age, title, place. */
function SessionCard({
  row,
  vault,
  now,
  focusable,
  onOpen,
  onFocus,
  className,
  ...props
}: Omit<ComponentProps<"button">, "onFocus"> & {
  row: SessionRow
  vault: string
  now: number
  focusable: boolean
  onOpen: () => void
  onFocus: () => void
}): React.JSX.Element {
  const { item, state, current } = row
  const by =
    item.by === undefined
      ? ""
      : `${item.by.kind === "holi" ? "Holi" : "Automation"} ${item.by.name}`
  const label = [item.title, stateWords(row), by].filter(Boolean).join(", ")
  const place = [vault, item.location].filter(Boolean).join(" · ")
  return (
    <button
      {...props}
      type="button"
      data-session-card={item.key}
      data-session-state={state}
      aria-current={current ? "true" : undefined}
      aria-label={label}
      tabIndex={focusable ? 0 : -1}
      onClick={onOpen}
      onFocus={onFocus}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1 rounded-lg border border-transparent px-2.5 py-2 text-start transition-colors outline-none",
        "hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50",
        state === "needs-you" && "border-dashed border-border",
        current &&
          "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent",
        className
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <CardMark row={row} />
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {item.by === undefined
              ? modelLabel(item.model)
              : `${item.by.name} · ${modelLabel(item.model)}`}
          </span>
        </span>
        <span className="flex shrink-0 items-center">
          <CardStatus row={row} now={now} />
        </span>
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {item.title}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{item.title}</TooltipContent>
      </Tooltip>
      {place !== "" && (
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{place}</span>
        </span>
      )}
    </button>
  )
}

/** What a card's context menu offers: its session's own actions while it is
 *  live, and Archive where its owner keeps an archive. */
function CardMenu({
  row,
  children,
}: {
  row: SessionRow
  children: React.ReactNode
}): React.JSX.Element {
  const live = useAtomValue(agentSessionsAtom)
  const archivable = useAtomValue(archivableOwnersAtom)
  const stop = useSetAtom(stopSessionAtom)
  const respawn = useSetAtom(respawnSessionAtom)
  const duplicate = useSetAtom(duplicateSessionAtom)
  const archive = useSetAtom(archiveSessionRowAtom)
  const { item } = row
  const jobId = item.jobId
  const isLive = jobId !== undefined && live.some((s) => s.id === jobId)
  const canArchive = archivable.has(keyOwner(item.key))
  if (!isLive && !canArchive) return <>{children}</>
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        {isLive && (
          <>
            <ContextMenuItem onSelect={() => void respawn(jobId)}>
              Restart
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void duplicate(jobId)}>
              Duplicate
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onSelect={() => void stop(jobId)}
            >
              Stop session
            </ContextMenuItem>
          </>
        )}
        {isLive && canArchive && <ContextMenuSeparator />}
        {canArchive && (
          <ContextMenuItem
            onSelect={() =>
              void archive({ key: item.key, archived: item.archived !== true })
            }
          >
            {item.archived === true ? "Unarchive" : "Archive"}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function LoadingCards(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label="Loading conversations"
      className="flex flex-col gap-1"
    >
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-1.5 px-2.5 py-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  )
}

/** The cards, grouped, with arrow keys between them. */
export function SessionList(): React.JSX.Element {
  const rows = useAtomValue(sessionRowsAtom)
  const status = useAtomValue(sessionsStatusAtom)
  const query = useAtomValue(sessionQueryAtom)
  const filter = useAtomValue(sessionFilterAtom)
  const vault = useAtomValue(sessionVaultNameAtom)
  const open = useSetAtom(openSessionRowAtom)
  const create = useSetAtom(newSessionAtom)
  const reload = useSetAtom(reloadSessionsAtom)
  const setQuery = useSetAtom(sessionQueryAtom)
  const setFilter = useSetAtom(sessionFilterAtom)
  const now = useNow()
  const listRef = useRef<HTMLDivElement>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)

  const visible = useMemo(
    () => rows.filter((r) => rowMatches(r, query, filter)),
    [rows, query, filter]
  )
  const groups = useMemo(() => groupRows(visible, now), [visible, now])
  const order = groups.flatMap((g) => g.rows.map((r) => r.item.key))
  // One card in the tab order: the focused one, else the open one, else the first.
  const tabKey =
    (focusKey !== null && order.includes(focusKey) && focusKey) ||
    visible.find((r) => r.current)?.item.key ||
    order[0]
  const listed = rows.some((r) => r.item.archived !== true || filter.archived)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"]
    if (!keys.includes(e.key)) return
    const cards = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-session-card]"
      ) ?? []
    )
    if (cards.length === 0) return
    e.preventDefault()
    const at = cards.findIndex((c) => c === document.activeElement)
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? cards.length - 1
          : e.key === "ArrowDown"
            ? Math.min(cards.length - 1, at + 1)
            : Math.max(0, at - 1)
    cards[next]?.focus()
  }

  return (
    <section aria-label="Sessions" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 ps-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          Sessions
          {rows.length > 0 && (
            <span className="tabular-nums">{visible.length}</span>
          )}
        </h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="New session"
              onClick={() => void create()}
            >
              <PlusIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">New session ⌘N</TooltipContent>
        </Tooltip>
      </div>

      {status === "error" ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground"
        >
          Could not load the conversations.
          <Button size="xs" variant="outline" onClick={() => reload()}>
            Retry
          </Button>
        </div>
      ) : status === "loading" && rows.length === 0 ? (
        <LoadingCards />
      ) : !listed ? (
        <Empty className="gap-3 p-4">
          <EmptyHeader>
            <EmptyTitle className="text-sm">No conversations yet</EmptyTitle>
            <EmptyDescription className="text-xs">
              Start one and it works in this vault while you write. Holis and
              automations list their runs here too.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => void create()}>
              <MessageSquarePlusIcon aria-hidden="true" />
              New session
            </Button>
          </EmptyContent>
        </Empty>
      ) : visible.length === 0 ? (
        <div className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
          No conversations match.
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setQuery("")
              setFilter(NO_FILTER)
            }}
          >
            Clear
          </Button>
        </div>
      ) : (
        <div
          ref={listRef}
          onKeyDown={onKeyDown}
          className="flex flex-col gap-3"
          data-session-list=""
        >
          {groups.map((group) => (
            <div
              key={group.id}
              role="group"
              aria-label={group.label}
              className="flex flex-col gap-0.5"
            >
              <div
                aria-hidden="true"
                className={cn(
                  "px-2 pb-0.5 text-xs text-muted-foreground",
                  group.id === "needs-you" && "font-medium text-foreground"
                )}
              >
                {group.label}
              </div>
              {group.rows.map((row) => (
                <CardMenu key={row.item.key} row={row}>
                  <SessionCard
                    row={row}
                    vault={vault}
                    now={now}
                    focusable={row.item.key === tabKey}
                    onFocus={() => setFocusKey(row.item.key)}
                    onOpen={() => void open(row.item)}
                  />
                </CardMenu>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
