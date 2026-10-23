/**
 * A chat session's conversation: the person's messages as bubbles on the
 * right; each of the agent's turns under a line that says who worked and for
 * how long ("Opus 5.5 worked for 6s"), its steps one line each, read as a
 * sentence ("Read `Meetings/Week kickoff.md`"), its reply as markdown, and
 * under a finished turn what you can do with it, what it cost and when it
 * landed. A permission Claude Code asks for is an inline card; its answer
 * goes back to Claude Code (`chats.answer`). So is an `AskUserQuestion`.
 *
 * Ported from MonoCode's `features/sessions/ui/AgentTranscript.tsx` (its turn
 * fold line, `TurnDuration`, `TurnMetricsBadge`, `CopyTurnButton`,
 * `SaveNoteButton`) and `ApprovalToasts.tsx`
 * (https://github.com/hardbeat920/monocode), MIT License, Copyright (c) 2026
 * Nick; see NOTICE.md. Holi's changes: shadcn's parts and tokens; "Save as
 * note" saves the reply as a vault document; MonoCode's second opinion,
 * handoff and activity toggle are left out, since a chat has no other harness
 * to ask and draws its steps inline.
 */
import { SiClaude } from "@icons-pack/react-simple-icons"
import { useAtomValue, useSetAtom } from "jotai"
import {
  BotIcon,
  ChartColumnIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleXIcon,
  CopyIcon,
  FilePenIcon,
  FilePlusIcon,
  FileTextIcon,
  GlobeIcon,
  type LucideIcon,
  SearchIcon,
  SparklesIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/reui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  activeRemoteAtom,
  openDocumentAtom,
  snapshotAtom,
  trpc,
} from "@/plugin-api"
import {
  modelLabel,
  needsSignIn,
  type Question,
  type ToolKind,
  type TranscriptItem,
  type TurnUsage,
} from "../shared/chat"
import { answerChatAtom, chatCap } from "./state/chats"
import { Markdown } from "./Markdown"

const TOOL_ICON: Record<ToolKind, LucideIcon> = {
  read: FileTextIcon,
  edit: FilePenIcon,
  search: SearchIcon,
  execute: SquareTerminalIcon,
  fetch: GlobeIcon,
  agent: BotIcon,
  skill: SparklesIcon,
  other: WrenchIcon,
}

/** "6s", "1m 12s", "2m": how long a turn worked. */
export function formatElapsed(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

/** "Opus 5.5 worked for 6s", "Working for 3s", after MonoCode's
 *  `formatWorkingDuration`. */
export function workedLabel(
  ms: number | null,
  model?: string,
  done = true
): string {
  const who = model === undefined ? undefined : modelLabel(model)
  const verb = done ? (who ? "worked" : "Worked") : who ? "working" : "Working"
  if (ms === null) return who ? `${who} ${verb}` : verb
  return who
    ? `${who} ${verb} for ${formatElapsed(ms)}`
    : `${verb} for ${formatElapsed(ms)}`
}

const count = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})
const formatCount = (n: number): string =>
  count.format(Math.max(0, Math.round(n))).toLowerCase()

/** The usage tooltip's two lines, after MonoCode's `TurnMetricsBadge`:
 *  "Cache hit 39% · Output 4 tok/s" over "2 input · 22 output · 12.7k cached". */
export function usageLines(
  usage: TurnUsage,
  elapsedMs: number
): { headline: string; detail: string } {
  const rate =
    usage.outputTokens !== undefined && elapsedMs > 0
      ? usage.outputTokens / (elapsedMs / 1000)
      : undefined
  const headline =
    [
      usage.cacheHitPercent !== undefined
        ? `Cache hit ${Math.round(usage.cacheHitPercent)}%`
        : null,
      rate !== undefined ? `Output ${formatCount(rate)} tok/s` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Turn tokens"
  const detail = [
    usage.inputTokens !== undefined
      ? `${formatCount(usage.inputTokens)} input`
      : null,
    usage.outputTokens !== undefined
      ? `${formatCount(usage.outputTokens)} output`
      : null,
    usage.cacheReadTokens !== undefined
      ? `${formatCount(usage.cacheReadTokens)} cached`
      : null,
  ]
    .filter(Boolean)
    .join(" · ")
  return { headline, detail }
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
})

/** A clock that ticks once a second while `on`. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [on])
  return now
}

function Step({
  icon: Glyph,
  running,
  failed,
  children,
}: {
  icon: LucideIcon
  running: boolean
  failed?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm">
      {running ? (
        <Spinner
          aria-hidden="true"
          className="text-foreground size-3.5 motion-reduce:animate-none"
        />
      ) : failed ? (
        <CircleXIcon
          aria-hidden="true"
          className="text-destructive size-3.5 shrink-0"
        />
      ) : (
        <Glyph aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="text-foreground/85 font-mono text-xs">{children}</code>
  )
}

/** Sign this vault's Claude Code in: its `/login`, which needs a terminal of
 *  its own, the one place a chat opens one. Then send the message again. */
function SignIn() {
  const remote = useAtomValue(activeRemoteAtom)
  const [said, setSaid] = useState<string | null>(null)
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={() => {
        if (remote === null) return
        void chatCap.signIn(remote).then((res) => {
          setSaid(
            res.ok
              ? "Sign in in the terminal that opened, then send again."
              : res.message
          )
        })
      }}
    >
      {said ?? "Sign in"}
    </Button>
  )
}

function ApprovalCard({
  chatId,
  item,
}: {
  chatId: string
  item: Extract<TranscriptItem, { kind: "approval" }>
}) {
  const answer = useSetAtom(answerChatAtom)
  const [error, setError] = useState<string | null>(null)
  const send = (a: { kind: "allow"; always?: boolean } | { kind: "deny" }) => {
    setError(null)
    void answer({ id: chatId, requestId: item.requestId, answer: a }).then(
      (res) => {
        if (!res.ok) setError(res.message)
      }
    )
  }
  if (item.status !== "pending") {
    const said =
      item.status === "allowed"
        ? "Allowed"
        : item.status === "always"
          ? "Always allowed"
          : item.status === "denied"
            ? "Denied"
            : "Withdrawn"
    return (
      <Step
        icon={item.status === "denied" ? CircleXIcon : CheckIcon}
        running={false}
      >
        {said}: {item.verb}{" "}
        {item.subject !== undefined && <Code>{item.subject}</Code>}
      </Step>
    )
  }
  return (
    <Alert
      variant="warning"
      data-approval={item.requestId}
      aria-label="Permission request"
    >
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle className="line-clamp-none break-words">
        {item.verb}{" "}
        {item.subject !== undefined && (
          <code className="bg-muted rounded-md px-1.5 py-px font-mono text-xs">
            {item.subject}
          </code>
        )}
        ?
      </AlertTitle>
      <AlertDescription className="gap-2.5">
        {item.detail !== undefined ? (
          <p className="line-clamp-4 text-xs whitespace-pre-wrap">
            {item.detail}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            onClick={() => send({ kind: "allow" })}
          >
            Allow once
          </Button>
          {item.canAlways ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => send({ kind: "allow", always: true })}
            >
              Always allow
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => send({ kind: "deny" })}
          >
            Deny
          </Button>
          {error !== null ? (
            <span role="alert" className="text-destructive text-xs">
              {error}
            </span>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  )
}

function QuestionCard({
  chatId,
  item,
}: {
  chatId: string
  item: Extract<TranscriptItem, { kind: "question" }>
}) {
  const answer = useSetAtom(answerChatAtom)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const questions: Question[] = item.questions
  if (item.status !== "pending") {
    return (
      <Step icon={CheckIcon} running={false}>
        {item.status === "answered" ? "Answered" : "Skipped"}:{" "}
        {questions[0]?.question}
      </Step>
    )
  }
  const complete = questions.every((q) => picked[q.question] !== undefined)
  const reply = (
    a: { kind: "answer"; answers: Record<string, string> } | { kind: "deny" }
  ) =>
    void answer({ id: chatId, requestId: item.requestId, answer: a }).then(
      (res) => setError(res.ok ? null : res.message)
    )
  return (
    <Alert variant="info" aria-label="A question for you">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>A question for you</AlertTitle>
      <AlertDescription className="gap-3">
        {questions.map((q) => (
          <div key={q.question} className="flex flex-col gap-2">
            <p className="text-foreground">{q.question}</p>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => (
                <Button
                  key={o.label}
                  type="button"
                  size="xs"
                  variant={
                    picked[q.question] === o.label ? "default" : "outline"
                  }
                  aria-pressed={picked[q.question] === o.label}
                  onClick={() =>
                    setPicked((p) => ({ ...p, [q.question]: o.label }))
                  }
                >
                  {o.label}
                </Button>
              ))}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            disabled={!complete}
            onClick={() => reply({ kind: "answer", answers: picked })}
          >
            Answer
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => reply({ kind: "deny" })}
          >
            Skip
          </Button>
          {error !== null ? (
            <span role="alert" className="text-destructive text-xs">
              {error}
            </span>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  )
}

/** A vault path that is free, from a chat's title. */
export function freePath(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .replace(/[\\/:*?"<>|#^[\]…]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60)
      .trim() || "Reply"
  for (let n = 1; ; n++) {
    const path = n === 1 ? `${base}.md` : `${base} ${n}.md`
    if (!taken.has(path)) return path
  }
}

function ActionButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="text-muted-foreground"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Copy the turn's reply as markdown. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(false), 2_000)
    return () => window.clearTimeout(id)
  }, [copied])
  return (
    <ActionButton
      label={copied ? "Copied" : "Copy reply"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () =>
            toast.error("Couldn’t copy the reply. Select it and copy instead.")
        )
      }}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" />
      ) : (
        <CopyIcon aria-hidden="true" />
      )}
    </ActionButton>
  )
}

/** Save the turn's reply as a new vault document, then offer to open it. */
function SaveButton({ text, title }: { text: string; title: string }) {
  const remote = useAtomValue(activeRemoteAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const open = useSetAtom(openDocumentAtom)
  const [busy, setBusy] = useState(false)
  return (
    <ActionButton
      label="Save as document"
      disabled={busy || remote === null}
      onClick={() => {
        if (remote === null) return
        const path = freePath(title, new Set(snapshot.docs.map((d) => d.path)))
        setBusy(true)
        void trpc.notes.create
          .mutate({ remote, path, text: `${text.trim()}\n` })
          .then(
            () =>
              void toast.success(`Saved as ${path}`, {
                action: { label: "Open", onClick: () => open(path) },
              }),
            () =>
              void toast.error(
                "Couldn’t save the reply. Check that the vault is reachable, then try again."
              )
          )
          .finally(() => setBusy(false))
      }}
    >
      <FilePlusIcon aria-hidden="true" />
    </ActionButton>
  )
}

/** The usage icon, its tooltip what the turn cost. */
function UsageBadge({
  usage,
  elapsedMs,
}: {
  usage: TurnUsage
  elapsedMs: number
}) {
  const { headline, detail } = usageLines(usage, elapsedMs)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Turn usage: ${headline}${detail ? `. ${detail}` : ""}`}
          className="text-muted-foreground"
        >
          <ChartColumnIcon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        <span>{headline}</span>
        {detail ? <span className="opacity-70">{detail}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}

type TurnItem = Extract<TranscriptItem, { kind: "turn" }>

/** One turn of the agent's: its bracket and what it said and did. */
interface TurnGroup {
  turn: TurnItem | null
  items: TranscriptItem[]
}

/** The transcript as MonoCode draws it: each person's message, then the
 *  turn it started with everything up to the next message. */
function groupTurns(
  items: readonly TranscriptItem[]
): (Extract<TranscriptItem, { kind: "user" }> | TurnGroup)[] {
  const out: (Extract<TranscriptItem, { kind: "user" }> | TurnGroup)[] = []
  let group: TurnGroup | null = null
  for (const item of items) {
    if (item.kind === "user") {
      group = null
      out.push(item)
    } else if (item.kind === "turn") {
      group = { turn: item, items: [] }
      out.push(group)
    } else {
      if (group === null) {
        group = { turn: null, items: [] }
        out.push(group)
      }
      group.items.push(item)
    }
  }
  return out
}

function TurnView({
  chatId,
  title,
  group,
  now,
}: {
  chatId: string
  title: string
  group: TurnGroup
  now: number
}) {
  const { turn, items } = group
  const open = turn !== null && turn.endedAt === undefined
  const waitingOnYou = items.some(
    (i) =>
      (i.kind === "approval" || i.kind === "question") && i.status === "pending"
  )
  const elapsed =
    turn === null ? null : Math.max(0, (turn.endedAt ?? now) - turn.startedAt)
  const reply = items
    .filter(
      (i): i is Extract<TranscriptItem, { kind: "assistant" }> =>
        i.kind === "assistant"
    )
    .map((i) => i.text.trim())
    .filter((t) => t !== "")
    .join("\n\n")

  return (
    <div className="flex flex-col gap-3" data-turn={turn?.id}>
      {turn !== null ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          {open && !waitingOnYou ? (
            <Spinner
              aria-hidden="true"
              className="size-3.5 motion-reduce:animate-none"
            />
          ) : (
            <SiClaude
              aria-hidden="true"
              className="size-3.5 shrink-0 text-orange-500 dark:text-orange-400"
            />
          )}
          <span className="min-w-0 truncate">
            {open
              ? waitingOnYou
                ? "Waiting for you"
                : workedLabel(elapsed, turn.model, false)
              : workedLabel(elapsed, turn.model)}
          </span>
          {turn.failed === true ? (
            <span className="text-destructive">· stopped</span>
          ) : null}
        </div>
      ) : null}

      {items.map((item) => {
        switch (item.kind) {
          case "assistant":
            return item.text.trim() === "" ? null : (
              <Markdown key={item.id} text={item.text} />
            )
          case "reasoning":
            return item.streaming ? (
              <Step key={item.id} icon={SparklesIcon} running>
                Thinking…
              </Step>
            ) : null
          case "tool": {
            // A call waiting on the person is not working: its card says so.
            const running = item.status === "running" && !waitingOnYou
            return (
              <Step
                key={item.id}
                icon={TOOL_ICON[item.toolKind]}
                running={running}
                failed={item.status === "failed"}
              >
                {item.status === "running" ? item.active : item.title}{" "}
                {item.subject !== undefined ? (
                  <Code>{item.subject}</Code>
                ) : null}
              </Step>
            )
          }
          case "approval":
            return <ApprovalCard key={item.id} chatId={chatId} item={item} />
          case "question":
            return <QuestionCard key={item.id} chatId={chatId} item={item} />
          case "status":
            return (
              <p key={item.id} className="text-muted-foreground text-xs">
                {item.text}
              </p>
            )
          case "error":
            return (
              <div
                key={item.id}
                role="alert"
                className="text-destructive flex items-start gap-2 text-sm"
              >
                <CircleXIcon
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0"
                />
                <span className="min-w-0 break-words">{item.text}</span>
                {needsSignIn(item.text) ? <SignIn /> : null}
              </div>
            )
          default:
            return null
        }
      })}

      {turn !== null && turn.endedAt !== undefined ? (
        <div
          data-turn-actions=""
          className="text-muted-foreground -ms-1.5 flex min-w-0 items-center gap-2 text-xs"
        >
          <span className="flex shrink-0 items-center gap-0.5">
            {reply !== "" ? (
              <>
                <CopyButton text={reply} />
                <SaveButton text={reply} title={title} />
              </>
            ) : null}
            {turn.usage !== undefined ? (
              <UsageBadge usage={turn.usage} elapsedMs={elapsed ?? 0} />
            ) : null}
          </span>
          <span
            aria-hidden="true"
            className="bg-muted-foreground/40 size-[3px] shrink-0 rounded-full"
          />
          <time
            dateTime={new Date(turn.endedAt).toISOString()}
            className="tabular-nums"
          >
            {clock.format(new Date(turn.endedAt))}
          </time>
        </div>
      ) : null}
    </div>
  )
}

export interface TranscriptProps {
  chatId: string
  /** The chat's title: a saved reply's document is named after it. */
  title: string
  items: readonly TranscriptItem[]
  /** Drawn after the items: the review card. */
  footer?: React.ReactNode
}

export function Transcript({ chatId, title, items, footer }: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stuck = useRef(true)
  const open = items.some((i) => i.kind === "turn" && i.endedAt === undefined)
  const now = useTick(open)

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
    el.addEventListener("scroll", onScroll)
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      data-transcript={chatId}
    >
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pt-8 pb-4"
        aria-live="polite"
      >
        {groupTurns(items).map((entry) =>
          "kind" in entry ? (
            <div
              key={entry.id}
              className="bg-muted max-w-[80%] self-end rounded-2xl px-3.5 py-2 text-sm break-words whitespace-pre-wrap"
            >
              {entry.text}
            </div>
          ) : (
            <TurnView
              key={entry.turn?.id ?? entry.items[0]?.id ?? "lead"}
              chatId={chatId}
              title={title}
              group={entry}
              now={now}
            />
          )
        )}
        {footer}
      </div>
    </div>
  )
}

/** The transcript's loading state: rows the height of the real ones. */
export function TranscriptSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading the conversation"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 pt-8"
    >
      <Skeleton className="h-9 w-1/3 self-end rounded-2xl motion-reduce:animate-none" />
      <Skeleton className="h-4 w-1/4 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-1/2 motion-reduce:animate-none" />
    </div>
  )
}
