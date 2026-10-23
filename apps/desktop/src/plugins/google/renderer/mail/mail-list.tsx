import { useState, type ReactNode } from "react"
import {
  CalendarDaysIcon,
  FilePenIcon,
  FilterIcon,
  InboxIcon,
  MailXIcon,
  RefreshCwIcon,
  ReplyIcon,
  SearchIcon,
  SquarePenIcon,
  SquarePlusIcon,
  StarIcon,
  XIcon,
} from "lucide-react"
import { Badge } from "@/components/reui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/plugin-api"
import { listStamp } from "../mail-stamp"
import { CATEGORIES, NAV_FOLDERS, initialsOf } from "./data"
import type { DraftSummary, MailState, ThreadSummary } from "./use-mail"

// ── Filter Tabs ──

type FilterTab = "all" | "unread"

const TABS: { id: FilterTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
]

/** A Gmail tab's label for a row chip; Primary and no tab say nothing. */
function categoryChip(category: ThreadSummary["category"]): string | null {
  if (category === null || category === "primary") return null
  return CATEGORIES.find((c) => c.value === category)?.label ?? null
}

// ── Mail Preview Item ──

function MailRow({
  id,
  isSelected,
  onClick,
  children,
}: {
  id: string
  isSelected: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <div
      id={id}
      role="listitem"
      aria-current={isSelected ? "true" : undefined}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onClick()
        }
      }}
      className={cn(
        "relative flex cursor-pointer items-start gap-1.5 md:gap-2.5",
        "border-border/40 border-b px-1.5 py-2 md:px-3 md:py-3",
        "focus-visible:ring-ring transition-colors focus-visible:ring-1 focus-visible:outline-none focus-visible:ring-inset",
        isSelected
          ? "bg-accent/60 dark:bg-accent/20"
          : "hover:bg-accent/60 dark:hover:bg-accent/20"
      )}
    >
      {children}
    </div>
  )
}

function MailItem({
  thread,
  isSelected,
  onClick,
}: {
  thread: ThreadSummary
  isSelected: boolean
  onClick: () => void
}) {
  const chip = categoryChip(thread.category)
  return (
    <MailRow id={thread.id} isSelected={isSelected} onClick={onClick}>
      {/* Unread indicator */}
      <div className="flex w-2 shrink-0 justify-center pt-3 md:pt-3.5">
        {thread.unread && (
          <span
            className="bg-primary size-1.5 shrink-0 rounded-full"
            role="img"
            aria-label="Unread"
          />
        )}
      </div>

      {/* Avatar */}
      <Avatar className="mt-0.5 size-6 shrink-0 md:size-8">
        <AvatarFallback className="text-xs font-semibold">
          {initialsOf(thread.from.name, thread.from.email)}
        </AvatarFallback>
      </Avatar>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Sender row */}
        <div className="mb-1 flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-1">
            <span
              className={cn(
                "truncate text-sm leading-tight",
                thread.unread
                  ? "text-foreground font-semibold"
                  : "text-foreground/75 font-medium"
              )}
            >
              {thread.from.name}
            </span>
            {thread.messageCount > 1 && (
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {thread.messageCount}
              </span>
            )}
          </div>

          {/* Timestamp + icons */}
          <div className="flex shrink-0 items-center gap-1">
            {thread.starred && (
              <StarIcon
                className="size-3 fill-amber-400 text-amber-400 dark:fill-amber-500 dark:text-amber-500"
                role="img"
                aria-label="Starred"
              />
            )}
            {thread.hasDraft && (
              <FilePenIcon
                className="text-muted-foreground/50 size-3"
                role="img"
                aria-label="Unsent draft"
              />
            )}
            {thread.answered && (
              <ReplyIcon
                className="text-muted-foreground/50 size-3"
                role="img"
                aria-label="You replied"
              />
            )}
            {thread.hasInvite && (
              <CalendarDaysIcon
                className="text-muted-foreground/50 size-3"
                role="img"
                aria-label="Meeting invite"
              />
            )}
            <span
              className={cn(
                "text-xs whitespace-nowrap tabular-nums",
                thread.unread
                  ? "text-foreground/70 font-medium"
                  : "text-muted-foreground/60"
              )}
            >
              {listStamp(thread.date)}
            </span>
          </div>
        </div>

        {/* Subject */}
        <div className="mb-1 grid">
          <p
            className={cn(
              "min-w-0 truncate text-xs leading-tight",
              thread.unread
                ? "text-foreground/90 font-medium"
                : "text-foreground/70"
            )}
          >
            {thread.subject}
          </p>
        </div>

        {/* Preview */}
        <div className="mb-1 grid">
          <p className="text-muted-foreground truncate text-xs leading-snug">
            {thread.snippet}
          </p>
        </div>

        {/* Gmail's tab, outlined, and the person's own labels */}
        {(chip !== null || thread.labels.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {chip !== null && (
              <Badge variant="outline" size="sm">
                {chip}
              </Badge>
            )}
            {thread.labels.map((label) => (
              <Badge key={label} variant="secondary" size="sm">
                {label}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </MailRow>
  )
}

function recipients(draft: DraftSummary): string {
  if (draft.to.length === 0) return "(no recipient)"
  return draft.to
    .map((address) => (address.name === "" ? address.email : address.name))
    .join(", ")
}

function DraftItem({
  draft,
  onClick,
}: {
  draft: DraftSummary
  onClick: () => void
}) {
  const first = draft.to[0]
  return (
    <MailRow id={draft.draftId} isSelected={false} onClick={onClick}>
      <div className="flex w-2 shrink-0" />
      <Avatar className="mt-0.5 size-6 shrink-0 md:size-8">
        <AvatarFallback className="text-xs font-semibold">
          {first === undefined ? (
            <FilePenIcon className="size-3.5" aria-hidden="true" />
          ) : (
            initialsOf(first.name, first.email)
          )}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-1 flex items-center justify-between gap-1">
          <span className="text-foreground/75 truncate text-sm leading-tight font-medium">
            {recipients(draft)}
          </span>
          <span className="text-muted-foreground/60 shrink-0 text-xs whitespace-nowrap tabular-nums">
            {listStamp(draft.date)}
          </span>
        </div>
        <div className="mb-1 grid">
          <p className="text-foreground/70 min-w-0 truncate text-xs leading-tight">
            {draft.subject === "" ? "(no subject)" : draft.subject}
          </p>
        </div>
        <div className="mb-1 grid">
          <p className="text-muted-foreground truncate text-xs leading-snug">
            {draft.snippet}
          </p>
        </div>
      </div>
    </MailRow>
  )
}

/** Loading, in the rows' own shape. */
function MailSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label}>
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="border-border/40 flex items-start gap-1.5 border-b px-1.5 py-2 md:gap-2.5 md:px-3 md:py-3"
        >
          <div className="w-2 shrink-0" />
          <Skeleton className="size-6 shrink-0 rounded-full md:size-8" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** The list's empty, error and disconnected states, in the block's look. */
function ListMessage({
  icon,
  title,
  description,
  action,
  alert,
}: {
  icon: ReactNode
  title: string
  description?: string
  action?: ReactNode
  alert?: boolean
}) {
  return (
    <Empty role={alert ? "alert" : undefined} className="py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description !== undefined && (
          <EmptyDescription>{description}</EmptyDescription>
        )}
      </EmptyHeader>
      {action !== undefined && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}

// ── Mail List ──

interface MailListProps {
  mail: MailState
  onCompose: () => void
  onOpenDraft: (draft: DraftSummary) => void
  onOpenConnections: () => void
}

export function MailList({
  mail,
  onCompose,
  onOpenDraft,
  onOpenConnections,
}: MailListProps) {
  const [query, setQuery] = useState("")
  const folder = NAV_FOLDERS.find((f) => f.id === mail.folder)!
  const inbox = mail.folder === "inbox" && !mail.searching
  /** Sent and Drafts have no unread state. */
  const filterable = mail.folder !== "sent" && !mail.showsDrafts
  const categoryLabel =
    CATEGORIES.find((c) => c.value === mail.category)?.label ?? "All tabs"

  const title = mail.searching
    ? "Search"
    : inbox && mail.category !== null
      ? categoryLabel
      : folder.label
  const unreadCount = !inbox
    ? null
    : mail.category === null
      ? (mail.counts?.unread ?? null)
      : (mail.categoryCounts?.[mail.category]?.count ?? null)

  const clearSearch = () => {
    setQuery("")
    mail.search("")
  }

  const body = (() => {
    if (mail.showsDrafts) {
      const drafts = mail.drafts
      if (drafts.kind === "loading")
        return <MailSkeleton label="Loading drafts" />
      if (drafts.kind === "error")
        return (
          <ListMessage
            alert
            icon={<MailXIcon aria-hidden="true" />}
            title="Couldn’t load your drafts"
            description={drafts.message}
            action={
              <Button variant="outline" size="xs" onClick={mail.reloadDrafts}>
                Try again
              </Button>
            }
          />
        )
      if (drafts.drafts.length === 0)
        return (
          <ListMessage
            icon={<FilePenIcon aria-hidden="true" />}
            title="No drafts"
            description="A message you start and leave unsent waits here."
            action={
              <Button variant="outline" size="xs" onClick={onCompose}>
                <SquarePlusIcon aria-hidden="true" />
                Compose
              </Button>
            }
          />
        )
      return (
        <div role="list" aria-label="Drafts">
          {drafts.drafts.map((draft) => (
            <DraftItem
              key={draft.draftId}
              draft={draft}
              onClick={() => onOpenDraft(draft)}
            />
          ))}
        </div>
      )
    }

    const list = mail.list
    if (list.kind === "loading") return <MailSkeleton label="Loading mail" />
    if (list.kind === "disconnected")
      return (
        <ListMessage
          icon={<MailXIcon aria-hidden="true" />}
          title="Google isn’t connected"
          description="Connect an account to read mail here."
          action={
            <Button variant="outline" size="xs" onClick={onOpenConnections}>
              Open Connections
            </Button>
          }
        />
      )
    if (list.kind === "error")
      return (
        <ListMessage
          alert
          icon={<MailXIcon aria-hidden="true" />}
          title="Couldn’t load your mail"
          description={list.message}
          action={
            <Button variant="outline" size="xs" onClick={mail.load}>
              Try again
            </Button>
          }
        />
      )
    if (list.threads.length === 0)
      return (
        <ListMessage
          icon={<InboxIcon aria-hidden="true" />}
          title={
            mail.searching
              ? "No messages matching your search"
              : mail.unreadOnly && filterable
                ? "Nothing unread"
                : `Nothing in ${title}`
          }
          description={
            inbox && mail.category !== null
              ? "Gmail’s tabs only apply if your inbox uses them."
              : undefined
          }
          action={
            mail.searching ? (
              <Button variant="outline" size="xs" onClick={clearSearch}>
                Clear search
              </Button>
            ) : mail.unreadOnly && filterable ? (
              <Button
                variant="outline"
                size="xs"
                onClick={() => mail.setUnreadOnly(false)}
              >
                Show all mail
              </Button>
            ) : (
              <Button variant="outline" size="xs" onClick={onCompose}>
                <SquarePlusIcon aria-hidden="true" />
                Compose
              </Button>
            )
          }
        />
      )
    return (
      <>
        <div role="list" aria-label={title}>
          {list.threads.map((thread) => (
            <MailItem
              key={thread.id}
              thread={thread}
              isSelected={mail.openId === thread.id}
              onClick={() => mail.openThread(thread)}
            />
          ))}
        </div>
        {list.nextPageToken !== null && (
          <div className="flex justify-center px-3 py-3">
            {/* A button, not an infinite scroll: Gmail is rate limited. */}
            <Button
              variant="outline"
              size="xs"
              disabled={mail.loadingMore}
              onClick={mail.loadMore}
            >
              {mail.loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </>
    )
  })()

  const tab: FilterTab = mail.unreadOnly && filterable ? "unread" : "all"

  return (
    <div className={cn("bg-background flex flex-1 flex-col overflow-hidden")}>
      {/* ── Header ── */}
      <div className="border-border flex h-(--header-height) shrink-0 items-center justify-between border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm leading-relaxed font-semibold">
            {title}
          </span>
          {unreadCount !== null && unreadCount > 0 && (
            <Badge className="rounded-full!" variant="outline" size="sm">
              {unreadCount}
            </Badge>
          )}
        </div>

        {/* Header tools */}
        <div className="flex items-center gap-0.5">
          {/* Refresh */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh mail"
                onClick={mail.refresh}
                className="[&_svg]:opacity-60 [&_svg]:transition-opacity hover:[&_svg]:opacity-100"
              >
                <RefreshCwIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>

          {/* Gmail's tabs: the inbox's own subdivisions */}
          {inbox && (
            <DropdownMenu
              onOpenChange={(open) => {
                if (open && mail.categoryCounts === null)
                  mail.loadCategoryCounts()
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Inbox tab: ${categoryLabel}`}
                  className="[&_svg]:opacity-60 [&_svg]:transition-opacity hover:[&_svg]:opacity-100"
                >
                  <FilterIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-muted-foreground text-xs">
                    Gmail tab
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={mail.category ?? "all"}
                    onValueChange={(value) =>
                      mail.setCategory(
                        value === "all"
                          ? null
                          : (value as NonNullable<typeof mail.category>)
                      )
                    }
                  >
                    {CATEGORIES.map((category) => {
                      const count =
                        category.value === null
                          ? mail.counts?.unread
                          : mail.categoryCounts?.[category.value]
                      const shown =
                        typeof count === "number"
                          ? count
                          : count == null
                            ? null
                            : `${count.count}${count.more ? "+" : ""}`
                      return (
                        <DropdownMenuRadioItem
                          key={category.value ?? "all"}
                          value={category.value ?? "all"}
                        >
                          {category.label}
                          {shown !== null && shown !== 0 && (
                            <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                              {shown}
                            </span>
                          )}
                        </DropdownMenuRadioItem>
                      )
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Compose */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Compose new email"
                onClick={onCompose}
                className="[&_svg]:opacity-60 [&_svg]:transition-opacity hover:[&_svg]:opacity-100"
              >
                <SquarePenIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Compose</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* ── Search: Gmail's own grammar, sent on Enter ── */}
      <div className="border-border/60 border-b px-3 py-2">
        <div className="relative">
          <SearchIcon
            className="text-muted-foreground/50 pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            placeholder="Search mail..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") mail.search(query.trim())
              if (e.key === "Escape" && query !== "") clearSearch()
            }}
            className="h-7 pl-7 text-xs"
            aria-label="Search mail"
          />
          {(query !== "" || mail.searching) && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={clearSearch}
              aria-label="Clear search"
              className="text-muted-foreground/50 hover:text-foreground absolute top-1/2 right-1 size-5 -translate-y-1/2"
            >
              <XIcon aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      {/* Why the last write did not stick: above the list, since archive
          and trash close the reader that raised it. */}
      {mail.writeError !== null && (
        <div
          role="alert"
          className="border-border/60 text-destructive flex shrink-0 items-center gap-2 border-b py-1.5 pr-1.5 pl-3 text-xs"
        >
          <span className="min-w-0 flex-1 text-pretty">{mail.writeError}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            onClick={mail.dismissWriteError}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      )}

      {/* ── Filter Tabs + Mail Content ── */}
      <Tabs
        value={tab}
        onValueChange={(v) => mail.setUnreadOnly(v === "unread")}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        {/* Tab bar row: only where there is an unread state */}
        {filterable && (
          <div className="border-border/60 flex shrink-0 items-center overflow-x-auto border-b px-1.5 py-1.5 md:px-2">
            <TabsList className="h-auto gap-0.5 bg-transparent p-0">
              {TABS.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  className={cn(
                    "group/tab h-auto flex-none gap-1 px-2 py-0.75 text-xs font-normal md:gap-2 md:px-2.5",
                    "data-active:bg-primary! data-active:text-primary-foreground! data-active:font-medium! data-active:shadow-none!",
                    "dark:data-active:bg-primary! dark:data-active:text-primary-foreground!",
                    "rounded-full"
                  )}
                >
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        )}

        <TabsContent value={tab} className="max-h-full min-h-0 grow">
          <ScrollArea className="h-full grow [&>[data-slot=scroll-area-viewport]>div]:block! [&>[data-slot=scroll-area-viewport]>div]:h-full">
            {body}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}
