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
  ArchiveIcon,
  Columns2Icon,
  ArchiveRestoreIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleDotIcon,
  CopyIcon,
  CopyPlusIcon,
  EllipsisIcon,
  GitBranchIcon,
  ListFilterIcon,
  MailCheckIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  SquareIcon,
  Trash2Icon,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Input } from "@/components/ui/input"
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
import { cn, openTabAtom } from "@/plugin-api"
import { agentSessionsAtom } from "../state/sessions"
import {
  duplicateSessionAtom,
  respawnSessionAtom,
  stopSessionAtom,
} from "../state/send"
import {
  age,
  archiveSessionRowAtom,
  deleteSessionRowAtom,
  filterActive,
  keyOwner,
  groupRows,
  markSessionSeenAtom,
  markSessionUnreadAtom,
  modelLabel,
  newSessionAtom,
  NO_FILTER,
  openSessionRowAtom,
  pinSessionRowAtom,
  reloadSessionsAtom,
  renameSessionRowAtom,
  rowAbilitiesAtom,
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

/**
 * A card's menu, written once and drawn twice: as its right-click menu and as
 * the ⋯ button's dropdown, the keyboard's way to the same actions (after the
 * documents tree's). Each item is there only when something backs it: the
 * row's owner (its slot's `rename`, `pin`, `archive`, `remove`), this
 * machine's read state, or the live session's own verbs.
 */
type MenuAction =
  | {
      kind: "item"
      label: string
      icon: React.ReactNode
      destructive?: boolean
      run: () => void
    }
  | { kind: "separator" }

function ContextMenuActions({ actions }: { actions: MenuAction[] }) {
  return actions.map((action, index) =>
    action.kind === "separator" ? (
      <ContextMenuSeparator key={index} />
    ) : (
      <ContextMenuItem
        key={index}
        variant={action.destructive ? "destructive" : "default"}
        onSelect={action.run}
      >
        {action.icon}
        {action.label}
      </ContextMenuItem>
    )
  )
}

function DropdownMenuActions({ actions }: { actions: MenuAction[] }) {
  return actions.map((action, index) =>
    action.kind === "separator" ? (
      <DropdownMenuSeparator key={index} />
    ) : (
      <DropdownMenuItem
        key={index}
        variant={action.destructive ? "destructive" : "default"}
        onSelect={action.run}
      >
        {action.icon}
        {action.label}
      </DropdownMenuItem>
    )
  )
}

/** Groups of items, with a separator between the groups that have any. */
function joinGroups(groups: MenuAction[][]): MenuAction[] {
  return groups
    .filter((g) => g.length > 0)
    .flatMap((g, i) => (i === 0 ? g : [{ kind: "separator" as const }, ...g]))
}

/** What a row's menu offers, as data both menus draw. */
function useRowActions(
  row: SessionRow,
  { onRename, onDelete }: { onRename: () => void; onDelete: () => void }
): MenuAction[] {
  const live = useAtomValue(agentSessionsAtom)
  const abilities = useAtomValue(rowAbilitiesAtom)
  const stop = useSetAtom(stopSessionAtom)
  const respawn = useSetAtom(respawnSessionAtom)
  const duplicate = useSetAtom(duplicateSessionAtom)
  const archive = useSetAtom(archiveSessionRowAtom)
  const pin = useSetAtom(pinSessionRowAtom)
  const markRead = useSetAtom(markSessionSeenAtom)
  const markUnread = useSetAtom(markSessionUnreadAtom)
  const openTab = useSetAtom(openTabAtom)
  const { item, state } = row
  const can = abilities.get(keyOwner(item.key))
  const jobId = item.jobId
  const isLive = jobId !== undefined && live.some((s) => s.id === jobId)
  const sessionId = item.sessionId ?? jobId
  const icon = (Glyph: typeof PinIcon) => <Glyph aria-hidden="true" />

  // A row that selects something, or a live session, can be a tab of its
  // own beside the one in front.
  const selection =
    item.selection ??
    (isLive && jobId !== undefined
      ? { owner: "agent", id: `session:${jobId}` }
      : undefined)
  const place: MenuAction[] =
    selection === undefined
      ? []
      : [
          {
            kind: "item",
            label: "Open to the side",
            icon: icon(Columns2Icon),
            run: () => {
              markRead(item.key)
              openTab({ kind: "session", ...selection }, { beside: true })
            },
          },
        ]

  const own: MenuAction[] = []
  if (can?.pin) {
    own.push({
      kind: "item",
      label: item.pinned ? "Unpin" : "Pin to top",
      icon: icon(item.pinned ? PinOffIcon : PinIcon),
      run: () => void pin({ key: item.key, pinned: item.pinned !== true }),
    })
  }
  if (can?.rename) {
    own.push({
      kind: "item",
      label: "Rename",
      icon: icon(PencilIcon),
      run: onRename,
    })
  }
  // Read state is this machine's, for any row; one that is working or
  // waiting on you is neither.
  if (state === "done") {
    own.push({
      kind: "item",
      label: "Mark as read",
      icon: icon(MailCheckIcon),
      run: () => markRead(item.key),
    })
  } else if (state === "idle" && !row.current) {
    own.push({
      kind: "item",
      label: "Mark as unread",
      icon: icon(CircleDotIcon),
      run: () => markUnread(item.key),
    })
  }
  if (sessionId !== undefined) {
    own.push({
      kind: "item",
      label: "Copy session ID",
      icon: icon(CopyIcon),
      run: () => void navigator.clipboard?.writeText(sessionId),
    })
  }

  const running: MenuAction[] = isLive
    ? [
        {
          kind: "item",
          label: "Restart",
          icon: icon(RotateCwIcon),
          run: () => void respawn(jobId),
        },
        {
          kind: "item",
          label: "Duplicate",
          icon: icon(CopyPlusIcon),
          run: () => void duplicate(jobId),
        },
        {
          kind: "item",
          label: "Stop session",
          icon: icon(SquareIcon),
          destructive: true,
          run: () => void stop(jobId),
        },
      ]
    : []

  const keep: MenuAction[] = []
  if (can?.archive) {
    keep.push({
      kind: "item",
      label: item.archived === true ? "Unarchive" : "Archive",
      icon: icon(item.archived === true ? ArchiveRestoreIcon : ArchiveIcon),
      run: () =>
        void archive({ key: item.key, archived: item.archived !== true }),
    })
  }
  if (can?.remove) {
    keep.push({
      kind: "item",
      label: "Delete…",
      icon: icon(Trash2Icon),
      destructive: true,
      run: onDelete,
    })
  }
  return joinGroups([place, own, running, keep])
}

/** A card with its menus: right-click, and ⋯ on hover or focus. */
function CardWithMenu({
  row,
  renaming,
  onRename,
  onRenamed,
  onDelete,
  children,
}: {
  row: SessionRow
  renaming: boolean
  onRename: () => void
  onRenamed: () => void
  onDelete: () => void
  children: React.ReactNode
}): React.JSX.Element {
  // A Rename picked in a menu opens the field once the menu has closed, so
  // the menu handing focus back does not blur it shut again.
  const renameNext = useRef(false)
  const actions = useRowActions(row, {
    onRename: () => {
      renameNext.current = true
    },
    onDelete,
  })
  const closeAutoFocus = (event: Event) => {
    if (!renameNext.current) return
    renameNext.current = false
    event.preventDefault()
    onRename()
  }
  if (renaming) return <RenameField row={row} onDone={onRenamed} />
  if (actions.length === 0) return <>{children}</>
  return (
    <div className="group/card relative" data-session-row={row.item.key}>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent
          className="w-52"
          onCloseAutoFocus={(e) => {
            if (renameNext.current) closeAutoFocus(e)
            else e.preventDefault()
          }}
        >
          <ContextMenuActions actions={actions} />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`More actions for ${row.item.title}`}
            className="absolute end-1.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-focus-within/card:opacity-100 group-hover/card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none"
          >
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-52"
          onCloseAutoFocus={closeAutoFocus}
        >
          <DropdownMenuActions actions={actions} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** The card's title as a field: Enter saves, Escape cancels, and leaving it
 *  saves, as the documents tree's rename does. */
function RenameField({
  row,
  onDone,
}: {
  row: SessionRow
  onDone: () => void
}): React.JSX.Element {
  const rename = useSetAtom(renameSessionRowAtom)
  const done = useRef(false)
  const finish = (value: string | null) => {
    if (done.current) return
    done.current = true
    const title = value?.trim() ?? ""
    if (title !== "" && title !== row.item.title) {
      void rename({ key: row.item.key, title })
    }
    onDone()
  }
  return (
    <div className="px-1 py-1">
      <Input
        autoFocus
        defaultValue={row.item.title}
        aria-label={`Rename ${row.item.title}`}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            finish(e.currentTarget.value)
          } else if (e.key === "Escape") {
            e.preventDefault()
            finish(null)
          }
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  )
}

/** Delete, asked first: it names the session and says what stays. */
function DeleteDialog({
  row,
  onClose,
}: {
  row: SessionRow | null
  onClose: () => void
}): React.JSX.Element {
  const remove = useSetAtom(deleteSessionRowAtom)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    if (row === null) return
    setPending(true)
    setError(null)
    try {
      const res = (await remove(row.item.key)) as
        { ok: true } | { ok: false; message: string } | undefined
      if (res !== undefined && !res.ok) setError(res.message)
      else onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }
  return (
    <AlertDialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open && !pending) {
          setError(null)
          onClose()
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{row?.item.title ?? ""}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Holi forgets this conversation on this machine: its row and Holi’s
            copy of the transcript. Claude Code’s own transcript stays where
            Claude Code keeps it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(e) => {
              e.preventDefault()
              void confirm()
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SessionRow | null>(null)
  const abilities = useAtomValue(rowAbilitiesAtom)

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
                <CardWithMenu
                  key={row.item.key}
                  row={row}
                  renaming={renaming === row.item.key}
                  onRename={() => setRenaming(row.item.key)}
                  onRenamed={() => {
                    setRenaming(null)
                    // Back to the card, as the field found it.
                    requestAnimationFrame(() =>
                      listRef.current
                        ?.querySelector<HTMLButtonElement>(
                          `[data-session-card="${CSS.escape(row.item.key)}"]`
                        )
                        ?.focus()
                    )
                  }}
                  onDelete={() => setDeleting(row)}
                >
                  <SessionCard
                    row={row}
                    vault={vault}
                    now={now}
                    focusable={row.item.key === tabKey}
                    onFocus={() => setFocusKey(row.item.key)}
                    onOpen={() => void open(row.item)}
                    onKeyDown={(e) => {
                      // F2 renames, as it does in the documents tree.
                      if (
                        e.key === "F2" &&
                        abilities.get(keyOwner(row.item.key))?.rename
                      ) {
                        e.preventDefault()
                        setRenaming(row.item.key)
                      }
                    }}
                    className="group-hover/card:pe-9 group-focus-within/card:pe-9"
                  />
                </CardWithMenu>
              ))}
            </div>
          ))}
        </div>
      )}
      <DeleteDialog row={deleting} onClose={() => setDeleting(null)} />
    </section>
  )
}
