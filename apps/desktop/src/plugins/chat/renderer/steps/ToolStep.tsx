/**
 * One step of a turn, read as a sentence ("Read `notes.md`", "Reading…" while
 * it runs), that opens into what the tool returned. Collapsed by default, a
 * failed or refused step open; a body is mounted only once opened, so a long
 * session with hundreds of steps draws hundreds of lines and no more. An
 * edit's diff is not folded: it shows under its step, capped. A subagent's
 * call is a group: its description, its own steps under it while it works,
 * folded once it is done with its answer.
 *
 * Also the turn's other lines: thinking ("Thought for 4s", open for its text
 * when Claude Code sent any) and status (plan mode, compaction, retries,
 * hooks, a stop).
 *
 * After MonoCode's activity rows, `SubagentPanel` and `ActivityThinkingRow`
 * (`features/sessions/ui/AgentTranscript.tsx`, MIT, Copyright (c) 2026 Nick;
 * see NOTICE.md), on shadcn's collapsible.
 */
import {
  BanIcon,
  BotIcon,
  BrainIcon,
  ChevronRightIcon,
  CircleStopIcon,
  CircleXIcon,
  ClipboardListIcon,
  FilePenIcon,
  FileTextIcon,
  GaugeIcon,
  GlobeIcon,
  InfoIcon,
  type LucideIcon,
  PlugIcon,
  RotateCwIcon,
  SearchIcon,
  ShrinkIcon,
  SparklesIcon,
  SquareTerminalIcon,
  WebhookIcon,
  WrenchIcon,
} from "lucide-react"
import { memo, useState } from "react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/plugin-api"
import type {
  ApprovalStatus,
  StatusIcon,
  ToolKind,
  TranscriptItem,
} from "../../shared/chat"
import { Markdown } from "../Markdown"
import { hasBody, ToolBody } from "./bodies"
import { DiffBody } from "./DiffBody"
import { MonoBlock } from "./parts"

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>

export const TOOL_ICON: Record<ToolKind, LucideIcon> = {
  read: FileTextIcon,
  edit: FilePenIcon,
  search: SearchIcon,
  execute: SquareTerminalIcon,
  fetch: GlobeIcon,
  agent: BotIcon,
  skill: SparklesIcon,
  mcp: PlugIcon,
  other: WrenchIcon,
}

const STATUS_ICON: Record<StatusIcon, LucideIcon> = {
  plan: ClipboardListIcon,
  compact: ShrinkIcon,
  retry: RotateCwIcon,
  limit: GaugeIcon,
  hook: WebhookIcon,
  stop: CircleStopIcon,
  denied: BanIcon,
  command: SquareTerminalIcon,
  info: InfoIcon,
}

/** The chevron that turns as its row opens: transform only. */
const chevron =
  "text-muted-foreground/60 size-3.5 shrink-0 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[state=open]/step:rotate-90 motion-reduce:transition-none"

/** The row a step is read as. */
const rowClass =
  "group/row text-muted-foreground flex w-full min-w-0 items-center gap-2 rounded-md text-start text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="text-foreground/85 font-mono text-xs">{children}</code>
  )
}

/** A step's leading glyph: what it is, or that it runs, failed or was refused. */
function Glyph({
  icon: Icon,
  running,
  status,
}: {
  icon: LucideIcon
  running: boolean
  status?: ToolItem["status"]
}) {
  if (running) {
    return (
      <Spinner
        aria-hidden="true"
        className="text-foreground size-3.5 shrink-0 motion-reduce:animate-none"
      />
    )
  }
  if (status === "failed") {
    return (
      <CircleXIcon
        aria-hidden="true"
        className="text-destructive size-3.5 shrink-0"
      />
    )
  }
  if (status === "denied") {
    return (
      <BanIcon
        aria-hidden="true"
        className="text-destructive size-3.5 shrink-0"
      />
    )
  }
  return <Icon aria-hidden="true" className="size-3.5 shrink-0" />
}

/** A plain line of the turn: an icon and its words. */
export function Step({
  icon,
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
      <Glyph
        icon={icon}
        running={running}
        status={failed ? "failed" : undefined}
      />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

const APPROVED: Partial<Record<ApprovalStatus, string>> = {
  allowed: "allowed once",
  always: "always allowed",
}

function StepWords({
  item,
  running,
  answer,
  meta,
}: {
  item: ToolItem
  running: boolean
  answer?: ApprovalStatus
  meta?: string
}) {
  const said = answer === undefined ? undefined : APPROVED[answer]
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span className="min-w-0 truncate">
        {running || item.status === "running" ? item.active : item.title}{" "}
        {item.subject !== undefined ? <Code>{item.subject}</Code> : null}
      </span>
      {item.status === "denied" ? (
        <span className="text-destructive shrink-0 text-xs">not allowed</span>
      ) : null}
      {meta !== undefined ? (
        <span className="text-muted-foreground/70 shrink-0 text-xs">
          {meta}
        </span>
      ) : null}
      {said !== undefined ? (
        <span className="text-muted-foreground/70 shrink-0 text-xs">
          {said}
        </span>
      ) : null}
    </span>
  )
}

/** A body a step opens into, under the row, aligned with its words. */
function Body({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 ps-5.5 pt-1.5 pb-1">
      {children}
    </div>
  )
}

export interface ToolStepProps {
  item: ToolItem
  /** The call waits on the person: its card says so, so it is not "working". */
  waiting?: boolean
  /** How the person answered Claude Code's prompt for it, if it asked. */
  answer?: ApprovalStatus
  /** A subagent's own steps, for an `Agent` call. */
  steps?: readonly ToolItem[]
  /** Answers by call id, for a subagent's steps. */
  answers?: ReadonlyMap<string, ApprovalStatus>
}

export const ToolStep = memo(function ToolStep({
  item,
  waiting = false,
  answer,
  steps,
  answers,
}: ToolStepProps) {
  const running = item.status === "running" && !waiting
  const view = item.view
  const icon = TOOL_ICON[item.toolKind]
  const errorish = item.status === "failed" || item.status === "denied"

  if (view?.type === "agent" || item.toolKind === "agent") {
    return (
      <AgentStep
        item={item}
        running={running}
        steps={steps ?? []}
        answers={answers}
      />
    )
  }

  // An edit's change is the point of it: drawn under the step, not folded.
  if (view?.type === "diff") {
    return (
      <div className="flex min-w-0 flex-col" data-step={item.id}>
        <div className={rowClass}>
          <Glyph icon={icon} running={running} status={item.status} />
          <StepWords item={item} running={running} answer={answer} />
        </div>
        <Body>
          <DiffBody files={view.files} />
          {errorish && item.detail !== undefined ? (
            <MonoBlock text={item.detail} tone="error" max={4} />
          ) : null}
        </Body>
      </div>
    )
  }

  const body = hasBody(view) ? (
    <ToolBody view={view} />
  ) : item.detail !== undefined ? (
    // A transcript kept before steps had views: the result's text.
    <MonoBlock text={item.detail} tone={errorish ? "error" : undefined} />
  ) : null

  if (body === null) {
    return (
      <div className={rowClass} data-step={item.id}>
        <Glyph icon={icon} running={running} status={item.status} />
        <StepWords item={item} running={running} answer={answer} />
      </div>
    )
  }

  return (
    <Collapsible
      defaultOpen={errorish}
      className="group/step flex min-w-0 flex-col"
      data-step={item.id}
    >
      <CollapsibleTrigger asChild>
        <button type="button" className={rowClass}>
          <Glyph icon={icon} running={running} status={item.status} />
          <StepWords item={item} running={running} answer={answer} />
          <ChevronRightIcon aria-hidden="true" className={chevron} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Body>{body}</Body>
      </CollapsibleContent>
    </Collapsible>
  )
})

/** "3 steps", "3 steps, 1 failed": how far a subagent got. */
function countLine(steps: readonly ToolItem[]): string | undefined {
  if (steps.length === 0) return undefined
  const failed = steps.filter((s) => s.status === "failed").length
  const n = steps.length === 1 ? "1 step" : `${steps.length} steps`
  return failed === 0 ? n : `${n}, ${failed} failed`
}

/**
 * A subagent: its description, then its own steps under it on a rail. Open
 * while it works, so its steps can be followed; folded once done, until the
 * person opens it.
 */
function AgentStep({
  item,
  running,
  steps,
  answers,
}: {
  item: ToolItem
  running: boolean
  steps: readonly ToolItem[]
  answers?: ReadonlyMap<string, ApprovalStatus>
}) {
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? (running || item.status === "failed")
  const view = item.view?.type === "agent" ? item.view : undefined
  const meta = [view?.agentType, countLine(steps)].filter(Boolean).join(" · ")
  return (
    <Collapsible
      open={open}
      onOpenChange={setOverride}
      className="group/step flex min-w-0 flex-col"
      data-step={item.id}
      data-subagent=""
    >
      <CollapsibleTrigger asChild>
        <button type="button" className={rowClass}>
          <Glyph icon={BotIcon} running={running} status={item.status} />
          <StepWords
            item={item}
            running={running}
            meta={meta === "" ? undefined : meta}
          />
          <ChevronRightIcon aria-hidden="true" className={chevron} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border ms-1.5 mt-1.5 flex min-w-0 flex-col gap-2 border-s ps-4 pb-1">
          {steps.map((s) => (
            <ToolStep key={s.id} item={s} answer={answers?.get(s.id)} />
          ))}
          {steps.length === 0 && running ? (
            <p className="text-muted-foreground text-xs">Starting…</p>
          ) : null}
          {view?.result !== undefined ? (
            <Markdown text={view.result} className="text-foreground/80" />
          ) : item.detail !== undefined && !running ? (
            <MonoBlock
              text={item.detail}
              tone={item.status === "failed" ? "error" : undefined}
            />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** "Thought for 4s"; opens for the text when Claude Code sent any. */
export const Thought = memo(function Thought({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "reasoning" }>
}) {
  if (item.streaming) {
    return (
      <Step icon={BrainIcon} running>
        Thinking…
      </Step>
    )
  }
  const ms =
    item.startedAt !== undefined && item.endedAt !== undefined
      ? item.endedAt - item.startedAt
      : undefined
  const secs = ms === undefined ? undefined : Math.max(1, Math.round(ms / 1000))
  const label = secs === undefined ? "Thought" : `Thought for ${secs}s`
  const text = item.text.trim()
  if (text === "") {
    // Thinking Claude Code kept to itself: worth a line only when it took a while.
    if (secs === undefined || secs < 2) return null
    return (
      <Step icon={BrainIcon} running={false}>
        {label}
      </Step>
    )
  }
  return (
    <Collapsible className="group/step flex min-w-0 flex-col" data-thought="">
      <CollapsibleTrigger asChild>
        <button type="button" className={rowClass}>
          <BrainIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ChevronRightIcon aria-hidden="true" className={chevron} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Body>
          <Markdown text={text} className="text-muted-foreground" />
        </Body>
      </CollapsibleContent>
    </Collapsible>
  )
})

/** A line the turn reports: plan mode, compaction, a retry, a hook, a stop. */
export function StatusLine({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "status" }>
}) {
  const Icon = STATUS_ICON[item.icon ?? "info"]
  return (
    <div
      className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs"
      data-status={item.icon ?? "info"}
      role={item.tone === undefined ? undefined : "status"}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0",
          item.tone === "warning" && "text-warning",
          item.tone === "destructive" && "text-destructive"
        )}
      />
      <span className="min-w-0 truncate">{item.text}</span>
      {item.detail !== undefined ? (
        <span className="text-muted-foreground/70 min-w-0 truncate">
          · {item.detail}
        </span>
      ) : null}
    </div>
  )
}
