/**
 * A chat session's conversation: the person's messages as bubbles, the
 * agent's replies as markdown, and each tool call as one line, read as a
 * sentence ("Read `Meetings/Week kickoff.md`"), the one in flight in the
 * present tense beside the house orbit. A permission Claude Code asks for is an
 * inline card; its answer goes back to Claude Code (`chats.answer`).
 *
 * After MonoCode's `AgentTranscript` and `ApprovalToasts` (MIT, Copyright (c)
 * 2026 Nick; see NOTICE.md), cut to the mock's simplicity.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Bot,
  CircleAlert,
  CircleX,
  FilePen,
  FileText,
  Globe,
  LoaderCircle,
  type LucideIcon,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Icon } from '@/primitives'
import { activeRemoteAtom, appModeAtom, cn, openSurfaceAtom } from '@/plugin-api'
import { needsSignIn, type Question, type ToolKind, type TranscriptItem } from '../shared/chat'
import { answerChatAtom, chatCap } from './state/chats'
import { Markdown } from './Markdown'

const TOOL_ICON: Record<ToolKind, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  search: Search,
  execute: SquareTerminal,
  fetch: Globe,
  agent: Bot,
  skill: Sparkles,
  other: Wrench,
}

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function seconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function DateChip({ at }: { at: number }): React.JSX.Element {
  const d = new Date(at)
  return (
    <span className="self-center rounded-full bg-foreground/[0.04] px-2.5 py-0.5 text-xs text-muted-foreground">
      <span className="font-medium text-foreground/80">{dayFormat.format(d)}</span>{' '}
      {timeFormat.format(d)}
    </span>
  )
}

function Step({
  icon,
  running,
  failed,
  children,
}: {
  icon: LucideIcon
  running: boolean
  failed?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      {running ? (
        // The one in-flight loop: the house orbit, so the words beside it stay still.
        <Icon icon={LoaderCircle} size="sm" className="text-foreground motion-orbit" />
      ) : (
        <Icon
          icon={failed ? CircleX : icon}
          size="sm"
          className={cn(failed && 'text-destructive')}
        />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

/** Sign this vault's Claude Code in, in a terminal: its `/login`. Then
 *  send the message again. */
function SignIn(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const openSurface = useSetAtom(openSurfaceAtom)
  const setMode = useSetAtom(appModeAtom)
  return (
    <Button
      size="xs"
      variant="secondary"
      onClick={() => {
        if (remote === null) return
        void chatCap.signIn(remote).then((res) => {
          if (!res.ok) return
          setMode('documents')
          openSurface('agent', res.terminalId)
        })
      }}
    >
      Sign in
    </Button>
  )
}

function Code({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <code className="font-mono text-xs text-foreground/85">{children}</code>
}

function ApprovalCard({
  chatId,
  item,
}: {
  chatId: string
  item: Extract<TranscriptItem, { kind: 'approval' }>
}): React.JSX.Element {
  const answer = useSetAtom(answerChatAtom)
  const [error, setError] = useState<string | null>(null)
  const send = (a: { kind: 'allow'; always?: boolean } | { kind: 'deny' }) => {
    setError(null)
    void answer({ id: chatId, requestId: item.requestId, answer: a }).then((res) => {
      if (!res.ok) setError(res.message)
    })
  }
  if (item.status !== 'pending') {
    const said =
      item.status === 'allowed'
        ? 'Allowed'
        : item.status === 'always'
          ? 'Always allowed'
          : item.status === 'denied'
            ? 'Denied'
            : 'Withdrawn'
    return (
      <Step icon={item.status === 'denied' ? CircleX : CircleAlert} running={false}>
        {said}: {item.verb} {item.subject !== undefined && <Code>{item.subject}</Code>}
      </Step>
    )
  }
  return (
    <div
      role="group"
      aria-label="Permission request"
      data-approval={item.requestId}
      className="flex flex-col gap-2.5 rounded-xl bg-amber-500/[0.06] p-3 text-sm ring-1 ring-amber-500/25 ring-inset dark:bg-amber-400/[0.06] dark:ring-amber-400/25"
    >
      <div className="flex items-start gap-2">
        <Icon icon={CircleAlert} size="sm" className="mt-0.5 text-amber-600 dark:text-amber-400" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="min-w-0 break-words">
            {item.verb}{' '}
            {item.subject !== undefined && (
              <code className="rounded-md bg-foreground/[0.06] px-1.5 py-px font-mono text-xs">
                {item.subject}
              </code>
            )}
            ?
          </span>
          {item.detail !== undefined && (
            <span className="line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">
              {item.detail}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" onClick={() => send({ kind: 'allow' })}>
          Allow once
        </Button>
        {item.canAlways && (
          <Button
            size="xs"
            variant="secondary"
            onClick={() => send({ kind: 'allow', always: true })}
          >
            Always allow
          </Button>
        )}
        <Button size="xs" variant="secondary" onClick={() => send({ kind: 'deny' })}>
          Deny
        </Button>
        {error !== null && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  )
}

function QuestionCard({
  chatId,
  item,
}: {
  chatId: string
  item: Extract<TranscriptItem, { kind: 'question' }>
}): React.JSX.Element {
  const answer = useSetAtom(answerChatAtom)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const questions: Question[] = item.questions
  if (item.status !== 'pending') {
    return (
      <Step icon={CircleAlert} running={false}>
        {item.status === 'answered' ? 'Answered' : 'Skipped'}: {questions[0]?.question}
      </Step>
    )
  }
  const complete = questions.every((q) => picked[q.question] !== undefined)
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-amber-500/[0.06] p-3 text-sm ring-1 ring-amber-500/25 ring-inset dark:bg-amber-400/[0.06] dark:ring-amber-400/25">
      {questions.map((q) => (
        <div key={q.question} className="flex flex-col gap-2">
          <span>{q.question}</span>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((o) => (
              <Button
                key={o.label}
                size="xs"
                variant={picked[q.question] === o.label ? 'default' : 'secondary'}
                onClick={() => setPicked((p) => ({ ...p, [q.question]: o.label }))}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </div>
      ))}
      <div className="flex gap-1.5">
        <Button
          size="xs"
          disabled={!complete}
          onClick={() =>
            void answer({
              id: chatId,
              requestId: item.requestId,
              answer: { kind: 'answer', answers: picked },
            })
          }
        >
          Answer
        </Button>
        <Button
          size="xs"
          variant="secondary"
          onClick={() =>
            void answer({ id: chatId, requestId: item.requestId, answer: { kind: 'deny' } })
          }
        >
          Skip
        </Button>
      </div>
    </div>
  )
}

/** Who worked, for the line under a turn: the Holi's name, or none. */
export interface TranscriptProps {
  chatId: string
  items: readonly TranscriptItem[]
  /** A Holi's face and name, for "Ada worked for 6s". */
  worker?: { name: string; face: React.ReactNode }
  /** Drawn after the items: the review card. */
  footer?: React.ReactNode
}

export function Transcript({ chatId, items, worker, footer }: TranscriptProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stuck = useRef(true)

  // Follow the conversation while the person is at its end; leave them where
  // they are when they have scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el !== null && stuck.current) el.scrollTop = el.scrollHeight
  }, [items, footer])
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const open = [...items].reverse().find((i) => i.kind === 'turn')
  const turnOpen = open?.kind === 'turn' && open.endedAt === undefined
  const inFlight = items.some(
    (i) =>
      (i.kind === 'tool' && i.status === 'running') ||
      ((i.kind === 'assistant' || i.kind === 'reasoning') && i.streaming) ||
      ((i.kind === 'approval' || i.kind === 'question') && i.status === 'pending'),
  )

  const waitingOnYou = items.some(
    (i) => (i.kind === 'approval' || i.kind === 'question') && i.status === 'pending',
  )
  let lastDay = ''
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-transcript={chatId}>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-8 pb-4 pt-8" aria-live="polite">
        {items.map((item) => {
          switch (item.kind) {
            case 'user': {
              const day = new Date(item.at).toDateString()
              const chip =
                day !== lastDay && worker !== undefined ? <DateChip at={item.at} /> : null
              lastDay = day
              return (
                <div key={item.id} className="flex flex-col gap-4">
                  {chip}
                  <div className="max-w-[70%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-foreground/[0.08] px-3.5 py-2 text-sm">
                    {item.text}
                  </div>
                </div>
              )
            }
            case 'turn':
              if (item.endedAt === undefined) return null
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  {worker?.face}
                  {worker === undefined ? 'Worked' : `${worker.name} worked`} for{' '}
                  {seconds(item.endedAt - item.startedAt)}
                  {item.failed === true && <span className="text-destructive">· stopped</span>}
                </div>
              )
            case 'assistant':
              return item.text.trim() === '' ? null : <Markdown key={item.id} text={item.text} />
            case 'reasoning':
              return item.streaming ? (
                <Step key={item.id} icon={Sparkles} running>
                  Thinking…
                </Step>
              ) : null
            case 'tool': {
              // A call waiting on the person is not working: its card says so.
              const running = item.status === 'running' && !waitingOnYou
              return (
                <Step
                  key={item.id}
                  icon={TOOL_ICON[item.toolKind]}
                  running={running}
                  failed={item.status === 'failed'}
                >
                  {running ? (
                    <>
                      {item.active}
                      {item.subject !== undefined && ` ${item.subject}`}
                    </>
                  ) : item.status === 'running' ? (
                    <>
                      {item.active} {item.subject !== undefined && <Code>{item.subject}</Code>}
                    </>
                  ) : (
                    <>
                      {item.title} {item.subject !== undefined && <Code>{item.subject}</Code>}
                    </>
                  )}
                </Step>
              )
            }
            case 'approval':
              return <ApprovalCard key={item.id} chatId={chatId} item={item} />
            case 'question':
              return <QuestionCard key={item.id} chatId={chatId} item={item} />
            case 'status':
              return (
                <p key={item.id} className="text-xs text-muted-foreground">
                  {item.text}
                </p>
              )
            case 'error':
              return (
                <div key={item.id} className="flex items-start gap-2 text-sm text-destructive">
                  <Icon icon={CircleX} size="sm" className="mt-0.5" />
                  <span className="min-w-0 break-words">{item.text}</span>
                  {needsSignIn(item.text) && <SignIn />}
                </div>
              )
          }
        })}
        {turnOpen && !inFlight && (
          <Step icon={Bot} running>
            Working…
          </Step>
        )}
        {footer}
      </div>
    </div>
  )
}

/** The transcript's loading state: rows the height of the real ones. */
export function TranscriptSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label="Loading the conversation"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-8 pt-8"
    >
      <div className="h-9 w-1/3 self-end rounded-2xl motion-shimmer" />
      <div className="h-4 w-1/2 rounded motion-shimmer" />
      <div className="h-4 w-2/3 rounded motion-shimmer" />
    </div>
  )
}
