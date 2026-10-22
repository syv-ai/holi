/**
 * The rows of every kind of item but the user's own message and a tool call
 * (`UserBubble`, `ToolCard`). Each takes the item's fields and tolerates a
 * field of the wrong type, since the transcript is Claude Code's and not
 * ours; one it cannot draw at all throws into its row's boundary.
 */
import {
  CircleAlert,
  Info,
  ListChecks,
  SquareTerminal,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Icon } from '@/primitives'
import { cn } from '@/plugin-api'
import type { ChatItem } from '../../../../agent/renderer/public'
import { ChatMarkdown } from '../ChatMarkdown'
import { Disclose, RawBlock, RawDisclosure, Toggle, clipText, safeJson, str } from './parts'

type Of<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>

/** How long a thought stays open after the next row arrives. */
export const THOUGHT_CLOSE_MS = 1000

/**
 * The agent's visible reasoning, a disclosure. It is open while it is the
 * last row of a turn in progress and closes a moment after the next row
 * arrives, unless the person opened or closed it themselves.
 */
export function ThinkingRow({
  item,
  live,
  compact,
}: {
  item: Of<'thinking'>
  live: boolean
  compact: boolean
}): React.JSX.Element | null {
  const [chosen, setChosen] = useState<boolean | null>(null)
  const [auto, setAuto] = useState(live)
  useEffect(() => {
    if (live) {
      setAuto(true)
      return
    }
    const timer = setTimeout(() => setAuto(false), THOUGHT_CLOSE_MS)
    return () => clearTimeout(timer)
  }, [live])
  const text = str(item.text)
  if (text.trim() === '') return null
  const open = chosen ?? auto
  return (
    <div data-chat-row="thinking" data-open={open ? '' : undefined} className="text-sm">
      <Toggle
        open={open}
        onToggle={() => setChosen(!open)}
        className={cn('text-muted-foreground', live && 'motion-shimmer')}
      >
        {live ? 'Thinking' : 'Thought'}
      </Toggle>
      <Disclose open={open}>
        <div className="pl-5 text-muted-foreground">
          <ChatMarkdown text={text} compact={compact} />
        </div>
      </Disclose>
    </div>
  )
}

/** A slash command the person ran: a chip with the command, then its words. */
export function CommandRow({ item }: { item: Of<'command'> }): React.JSX.Element {
  const name = str(item.name)
  const args = str(item.args)
  return (
    <div data-chat-row="command" className="flex max-w-[85%] items-center gap-2 self-end text-sm">
      <span className="rounded-md bg-secondary px-2 py-0.5 font-mono text-xs text-secondary-foreground">
        {name.startsWith('/') || name === '' ? name : `/${name}`}
      </span>
      {args !== '' && <span className="min-w-0 truncate text-muted-foreground">{args}</span>}
    </div>
  )
}

/** A `!` shell command of the person's: the command, its output behind a
 *  disclosure. */
export function ShellRow({ item }: { item: Of<'shell'> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const command = str(item.command)
  const stdout = str(item.stdout)
  const stderr = str(item.stderr)
  const hasOutput = stdout.trim() !== '' || stderr.trim() !== ''
  return (
    <div data-chat-row="shell" className="flex flex-col items-start text-sm">
      <div className="flex w-full min-w-0 items-center gap-1.5 px-1 text-muted-foreground">
        <Icon icon={SquareTerminal} size="sm" />
        <span className="min-w-0 truncate font-mono text-xs">
          {command === '' ? 'Command output' : command}
        </span>
      </div>
      {hasOutput && (
        <>
          <Toggle open={open} onToggle={() => setOpen((o) => !o)} className="text-muted-foreground">
            Output
          </Toggle>
          <Disclose open={open}>
            <div className="flex flex-col gap-1 pl-5">
              {stdout.trim() !== '' && <RawBlock text={clipText(stdout, 20_000)} />}
              {stderr.trim() !== '' && (
                <RawBlock text={clipText(stderr, 20_000)} className="text-destructive" />
              )}
            </div>
          </Disclose>
        </>
      )}
    </div>
  )
}

/** The person stopped it. */
export function InterruptRow({ item }: { item: Of<'interrupt'> }): React.JSX.Element {
  return (
    <p data-chat-row="interrupt" className="px-1 text-xs text-muted-foreground">
      {item.forTool === true ? 'Interrupted during a tool call' : 'Interrupted'}
    </p>
  )
}

const TONES: Record<string, { icon: LucideIcon; text: string }> = {
  info: { icon: Info, text: 'text-muted-foreground' },
  warn: { icon: TriangleAlert, text: 'text-[var(--fill-warm)]' },
  error: { icon: CircleAlert, text: 'text-destructive' },
}

/** Something the system said: plain text in the tone's colour, the long part
 *  (a compaction summary, a hook's output) behind a disclosure. */
export function NoticeRow({ item }: { item: Of<'notice'> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const tone = TONES[item.tone] ?? TONES.info!
  const detail = str(item.detail)
  return (
    <div
      data-chat-row="notice"
      data-tone={item.tone}
      className={cn('flex flex-col text-sm', tone.text)}
    >
      <div className="flex items-start gap-1.5 px-1">
        <span className="mt-0.5 grid h-5 shrink-0 place-items-center">
          <Icon icon={tone.icon} size="sm" />
        </span>
        <span className="min-w-0 whitespace-pre-wrap">{str(item.text)}</span>
      </div>
      {detail !== '' && (
        <>
          <Toggle
            open={open}
            onToggle={() => setOpen((o) => !o)}
            className="ml-5 text-muted-foreground"
          >
            Details
          </Toggle>
          <Disclose open={open}>
            <div className="pl-5" data-chat-detail="">
              <RawBlock text={clipText(detail, 20_000)} />
            </div>
          </Disclose>
        </>
      )}
    </div>
  )
}

/** 168000 -> "168k". */
export function tokens(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  return n < 1000 ? String(Math.round(n)) : `${Math.round(n / 100) / 10}k`
}

/** The history above was compacted: a labelled divider. The turns stay shown. */
export function CompactionRow({ item }: { item: Of<'compaction'> }): React.JSX.Element {
  const before = tokens(item.preTokens)
  const after = tokens(item.postTokens)
  const counts =
    before !== null && after !== null
      ? ` · ${before} → ${after} tokens`
      : before !== null
        ? ` · ${before} tokens before`
        : ''
  return (
    <div
      data-chat-row="compaction"
      className="flex items-center gap-3 py-1 text-xs text-muted-foreground"
    >
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0">Conversation compacted{counts}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

/** 12400 -> "12s", 75000 -> "1m 15s". */
export function duration(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
  const s = Math.round(ms / 1000)
  if (s < 1) return 'under a second'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** A turn ended: the time it took, small and muted. */
export function TurnEndRow({ item }: { item: Of<'turn-end'> }): React.JSX.Element {
  const took = duration(item.durationMs)
  return (
    <p data-chat-row="turn-end" className="px-1 text-xs text-muted-foreground/80">
      {took === null ? 'Turn ended' : `Worked for ${took}`}
    </p>
  )
}

/** A background task reported: a slim status row. */
export function TaskNoteRow({ item }: { item: Of<'task-note'> }): React.JSX.Element {
  const status = str(item.status)
  const failed = /fail|error|kill|cancel|stop/i.test(status)
  return (
    <div
      data-chat-row="task-note"
      className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground"
    >
      <Icon icon={ListChecks} size="sm" />
      <span className={cn('shrink-0', failed && 'text-destructive')}>
        {status === '' ? 'Background task' : `Background task ${status}`}
      </span>
      {str(item.summary) !== '' && <span className="min-w-0 truncate">{str(item.summary)}</span>}
    </div>
  )
}

/** A line this build has no rule for, or an item kind it does not know (a
 *  newer main than this renderer): shown, with what it was. */
export function UnknownRow({
  shape,
  raw,
}: {
  shape: string
  raw: string | (() => string)
}): React.JSX.Element {
  return (
    <div
      data-chat-row="unknown"
      className="flex flex-col items-start text-sm text-muted-foreground"
    >
      <span className="px-1 text-xs">Unrecognised: {shape}</span>
      <RawDisclosure raw={raw} label="Show what it was" />
    </div>
  )
}

export function unknownItemRow(item: unknown): React.JSX.Element {
  const known = item as { kind?: unknown; shape?: unknown; raw?: unknown } | null
  const isUnknownKind = known?.kind === 'unknown'
  const shape = isUnknownKind
    ? str(known?.shape) || 'unknown'
    : `kind:${typeof known?.kind === 'string' ? known.kind : 'none'}`
  const raw = isUnknownKind && typeof known?.raw === 'string' ? known.raw : () => safeJson(item)
  return <UnknownRow shape={shape} raw={raw} />
}
