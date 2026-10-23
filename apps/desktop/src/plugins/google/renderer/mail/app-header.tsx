import {
  ArchiveIcon,
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CornerUpLeftIcon,
  ExternalLinkIcon,
  FilePenIcon,
  ForwardIcon,
  Link2Icon,
  MailIcon,
  MailMinusIcon,
  MoreHorizontalIcon,
  ReplyIcon,
  SparklesIcon,
  StarIcon,
  Trash2Icon,
  VideoIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/plugin-api"
import type { MailState } from "./use-mail"

// ── App Header ──

export interface ThreadCommands {
  reply: (all: boolean) => void
  forward: () => void
  continueDraft: () => void
  /** Present only while a plugin provides an agent. */
  summarize: (() => void) | null
  /** Present only in a vault that runs tasks. */
  linkToTask: (() => void) | null
}

interface AppHeaderProps {
  mail: MailState
  commands: ThreadCommands
}

/**
 * The reader's bar: step through the list, the open thread's subject, and
 * what can be done to it. Permanent delete is not here because Holi has no
 * scope for it; Trash is Gmail's, recoverable for 30 days.
 */
export function AppHeader({ mail, commands }: AppHeaderProps) {
  const reader = mail.reader
  const thread = reader.kind === "ready" ? reader.thread : null
  const row = mail.openRow
  const subject = thread?.subject ?? row?.subject ?? ""
  const starred = row?.starred === true
  const openId = mail.openId

  const index = mail.threads.findIndex((t) => t.id === openId)
  const previous = index > 0 ? mail.threads[index - 1] : undefined
  const next =
    index !== -1 && index < mail.threads.length - 1
      ? mail.threads[index + 1]
      : undefined
  const meeting = mail.meeting

  return (
    <header
      className={cn(
        "border-border flex h-(--header-height) min-w-0 shrink-0 items-center gap-1 border-b px-2 py-1.5",
        "sm:gap-1.5 sm:px-4"
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous thread"
        disabled={previous === undefined}
        onClick={() => previous !== undefined && mail.openThread(previous)}
        className="text-muted-foreground hidden shrink-0 sm:flex"
      >
        <ChevronLeftIcon aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next thread"
        disabled={next === undefined}
        onClick={() => next !== undefined && mail.openThread(next)}
        className="text-muted-foreground hidden shrink-0 sm:flex"
      >
        <ChevronRightIcon aria-hidden="true" />
      </Button>

      <div className="hidden items-center sm:flex">
        <Separator orientation="vertical" className="h-5" />
      </div>

      <h3 className="text-foreground w-0 flex-1 truncate text-sm leading-snug font-semibold">
        {subject}
      </h3>

      {/* Actions, once a thread is open */}
      {openId !== null && (
        <div
          role="toolbar"
          aria-label="Thread actions"
          className="ml-auto flex shrink-0 items-center gap-0.5"
        >
          {/* The only time-sensitive action: main matched the invite's UID
              to the calendar event, and this is that event's link. */}
          {meeting !== null && (
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5"
              aria-label={
                meeting.conferenceUrl !== null
                  ? `Join ${meeting.title}`
                  : `Open ${meeting.title} in Google Calendar`
              }
              onClick={() =>
                void window.holi.openExternal(
                  meeting.conferenceUrl ?? meeting.htmlLink
                )
              }
            >
              {meeting.conferenceUrl !== null ? (
                <VideoIcon aria-hidden="true" />
              ) : (
                <CalendarDaysIcon aria-hidden="true" />
              )}
              {meeting.conferenceUrl !== null ? "Join" : "Meeting"}
            </Button>
          )}

          <Button
            variant="secondary"
            size="sm"
            aria-label="Reply all"
            disabled={thread === null}
            onClick={() => commands.reply(true)}
            className="hidden gap-1.5 sm:flex"
          >
            <CornerUpLeftIcon aria-hidden="true" />
            Reply all
          </Button>

          <div className="me-0.5 ml-2 hidden items-center sm:flex">
            <Separator orientation="vertical" className="h-5" />
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={starred ? "Unstar thread" : "Star thread"}
                aria-pressed={starred}
                onClick={() => void mail.setStarred(openId, !starred)}
              >
                <StarIcon
                  aria-hidden="true"
                  className={cn(
                    "shrink-0",
                    starred
                      ? "fill-amber-500 text-amber-500 dark:fill-amber-400 dark:text-amber-400"
                      : "text-muted-foreground"
                  )}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{starred ? "Unstar" : "Star"}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Archive thread"
                onClick={() => void mail.removeThreads([openId], "archive")}
                className="text-muted-foreground shrink-0"
              >
                <ArchiveIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Archive: out of the inbox, kept in All Mail
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Move thread to trash"
                onClick={() => void mail.removeThreads([openId], "trash")}
                className="text-muted-foreground hover:text-destructive shrink-0"
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Move to trash: recoverable for 30 days
            </TooltipContent>
          </Tooltip>

          <div className="mx-0.5 hidden items-center sm:flex">
            <Separator orientation="vertical" className="h-5" />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="More actions"
                className="text-muted-foreground shrink-0"
              >
                <MoreHorizontalIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={thread === null}
                  onSelect={() => commands.reply(false)}
                >
                  <ReplyIcon aria-hidden="true" />
                  Reply
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={thread === null}
                  onSelect={commands.forward}
                >
                  <ForwardIcon aria-hidden="true" />
                  Forward
                </DropdownMenuItem>
                {row?.hasDraft === true && (
                  <DropdownMenuItem onSelect={commands.continueDraft}>
                    <FilePenIcon aria-hidden="true" />
                    Continue your draft
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() => void mail.setRead(openId, false)}
                >
                  <MailIcon aria-hidden="true" />
                  Mark as unread
                </DropdownMenuItem>
              </DropdownMenuGroup>

              {(commands.summarize !== null ||
                commands.linkToTask !== null) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    {commands.summarize !== null && (
                      <DropdownMenuItem
                        disabled={thread === null}
                        onSelect={commands.summarize}
                      >
                        <SparklesIcon aria-hidden="true" />
                        Summarize with the assistant
                      </DropdownMenuItem>
                    )}
                    {commands.linkToTask !== null && (
                      <DropdownMenuItem onSelect={commands.linkToTask}>
                        <Link2Icon aria-hidden="true" />
                        Make a task linking this thread
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </>
              )}

              <DropdownMenuSeparator />

              <DropdownMenuGroup>
                {/* Advertised by the sender; opened, never requested. */}
                {row?.unsubscribeUrl != null && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void window.holi.openExternal(row.unsubscribeUrl!)
                    }
                  >
                    <MailMinusIcon aria-hidden="true" />
                    Open the sender’s unsubscribe page
                  </DropdownMenuItem>
                )}
                {(thread?.webUrl ?? row?.webUrl) !== undefined && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void window.holi.openExternal(
                        (thread?.webUrl ?? row?.webUrl)!
                      )
                    }
                  >
                    <ExternalLinkIcon aria-hidden="true" />
                    Open in Gmail
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </header>
  )
}
