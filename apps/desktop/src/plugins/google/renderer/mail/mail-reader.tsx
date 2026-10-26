import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  MailOpenIcon,
  MailXIcon,
  PaperclipIcon,
  SquarePlusIcon,
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { messageStamp } from '../mail-stamp'
import type { MailAddress, MailAttachment, ThreadMessage } from '../mail-types'
import { SandboxedHtml } from '../sandboxed-html'
import { fileSize, initialsOf } from './data'
import type { MailState } from './use-mail'

/**
 * The open thread, filling the block's content area. Every body goes through
 * `SandboxedHtml`, the same sanitiser, sandboxed frame and remote-content
 * blocking the old reader uses (docs/features/google.md, Rules).
 */
export function MailReader({
  mail,
  composer,
  onCompose,
}: {
  mail: MailState
  /** The inline reply or forward, at the foot of the thread it answers. */
  composer: ReactNode
  onCompose: () => void
}) {
  const reader = mail.reader

  if (reader.kind === 'idle') {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MailOpenIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Pick a thread to read it</EmptyTitle>
          <EmptyDescription>Or start a new message.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="xs" onClick={onCompose}>
            <SquarePlusIcon aria-hidden="true" />
            Compose
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  if (reader.kind === 'loading') {
    return (
      <div role="status" aria-label="Loading the thread" className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-1/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    )
  }

  if (reader.kind === 'error') {
    return (
      <Empty role="alert" className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MailXIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Couldn’t open this thread</EmptyTitle>
          <EmptyDescription>{reader.message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="xs" onClick={mail.reloadThread}>
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  const { thread } = reader
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col px-4 pb-8">
        {thread.messages.map((message, index) => (
          <MessageBlock
            key={message.id}
            message={message}
            threadUrl={thread.webUrl}
            // Only the last opens expanded, so a long thread does not bury
            // what is new.
            initiallyOpen={index === thread.messages.length - 1}
            position={index + 1}
            total={thread.messages.length}
          />
        ))}
        {composer}
      </div>
    </div>
  )
}

function MessageBlock({
  message,
  threadUrl,
  initiallyOpen,
  position,
  total,
}: {
  message: ThreadMessage
  threadUrl: string
  initiallyOpen: boolean
  position: number
  total: number
}) {
  const [expanded, setExpanded] = useState(initiallyOpen)

  return (
    <Collapsible asChild open={expanded} onOpenChange={setExpanded}>
      <article className="border-border/60 flex flex-col gap-3 border-b py-4 last:border-0">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="row"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} message ${position} of ${total} from ${message.from.name}`}
            className="w-full"
          >
            <Avatar>
              <AvatarFallback className="text-xs font-semibold">
                {initialsOf(message.from.name, message.from.email)}
              </AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <span className="text-foreground truncate text-sm font-semibold">
                  {message.from.name}
                </span>
                {message.from.email !== '' && (
                  <span className="text-muted-foreground hidden truncate text-xs md:inline">
                    {message.from.email}
                  </span>
                )}
              </span>
              {!expanded && (
                <span className="text-muted-foreground truncate text-xs">
                  {message.body.slice(0, 200)}
                </span>
              )}
            </span>
            <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs tabular-nums">
              {total > 1 && (
                <span>
                  {position}/{total}
                </span>
              )}
              <span>{messageStamp(message.date)}</span>
              {expanded ? (
                <ChevronDownIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronRightIcon className="size-3.5" aria-hidden="true" />
              )}
            </span>
          </Button>
        </CollapsibleTrigger>

        {/* Only an open message builds its frame. */}
        <CollapsibleContent>
          <div className="flex flex-col gap-3 md:pl-10.5">
            <MessageAddresses message={message} />
            <MessageBody message={message} />
            <Attachments attachments={message.attachments} webUrl={threadUrl} />
          </div>
        </CollapsibleContent>
      </article>
    </Collapsible>
  )
}

/** Who a message went to; a row is absent rather than empty. */
function MessageAddresses({ message }: { message: ThreadMessage }) {
  const rows: { label: string; addresses: MailAddress[] }[] = [
    { label: 'To', addresses: message.to },
    { label: 'Cc', addresses: message.cc },
    { label: 'Bcc', addresses: message.bcc },
  ]
  const shown = rows.filter((row) => row.addresses.length > 0)
  if (shown.length === 0) return null
  return (
    <dl
      className="text-muted-foreground grid grid-cols-(--meta-cols) gap-x-2 gap-y-0.5 text-xs"
      style={{ '--meta-cols': 'auto 1fr' } as CSSProperties}
    >
      {shown.map((row) => (
        <div key={row.label} className="col-span-2 grid grid-cols-subgrid">
          <dt>{row.label}</dt>
          <dd className="min-w-0 break-words">
            {row.addresses
              .map((a) =>
                a.name !== '' && a.name !== a.email ? `${a.name} <${a.email}>` : a.email,
              )
              .join(', ')}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** A sandboxed frame when there is HTML, the plain text otherwise. */
function MessageBody({ message }: { message: ThreadMessage }) {
  if (message.html === null) {
    return <p className="text-sm break-words whitespace-pre-wrap">{message.body}</p>
  }
  return (
    <SandboxedHtml
      html={message.html}
      label={`Message from ${message.from.name}`}
      identity={{ key: message.id, sender: message.from.email }}
    />
  )
}

/**
 * What came with a message, in the block's attachment group. Each opens the
 * thread in Gmail: Holi does not fetch attachment bytes.
 */
function Attachments({ attachments, webUrl }: { attachments: MailAttachment[]; webUrl: string }) {
  if (attachments.length === 0) return null
  const open = () => void window.holi.openExternal(webUrl)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {attachments.map((attachment, index) => (
        <ButtonGroup key={`${attachment.filename}:${index}`}>
          <Button variant="outline" size="xs" onClick={open} className="max-w-60">
            <PaperclipIcon aria-hidden="true" />
            <span className="truncate">{attachment.filename}</span>
            <span className="hidden shrink-0 opacity-50 md:inline-block">
              ({fileSize(attachment.size)})
            </span>
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-xs"
                aria-label={`Open ${attachment.filename} in Gmail`}
                onClick={open}
              >
                <ExternalLinkIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Opens in Gmail</TooltipContent>
          </Tooltip>
        </ButtonGroup>
      ))}
    </div>
  )
}
