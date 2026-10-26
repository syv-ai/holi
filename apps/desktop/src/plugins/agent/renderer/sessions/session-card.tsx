/**
 * A session card (docs/features/agent-sessions.md, The Agents view), after
 * MonoCode's `Sidebar.tsx` session card (MIT, Copyright (c) 2026 Nick; see
 * NOTICE.md): the provider's mark and the model with the age on the right, the
 * title, then where it runs. "A state worth noticing takes the time's place":
 * working spins, needs you is a badge and pins the row to the top, done shows
 * a check until the row is opened.
 */
import { CheckIcon, CircleAlertIcon, ZapIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentMark } from '@/composites/marks'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { cn } from '@/plugin-api'
import { DEFAULT_HOLI_COLOUR, relativeAge } from '@holi/shared'
import { modelLabel, type SessionRow } from '../state/session-list'

/** The state or the age, right-aligned on the card's first line. */
function CardStatus({ row, now }: { row: SessionRow; now: number }): React.JSX.Element {
  const { item, state } = row
  if (state === 'needs-you') {
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
  if (state === 'working') {
    return (
      <span className="flex items-center gap-1 text-xs text-foreground">
        <Spinner aria-hidden="true" role="presentation" className="size-3" />
        Working
      </span>
    )
  }
  const when = relativeAge(item.endedAt ?? item.updatedAt, now, { precise: true })
  if (state === 'done') {
    return (
      <span className="flex items-center gap-1 text-xs text-success-foreground tabular-nums">
        <CheckIcon aria-hidden="true" className="size-3" />
        <span className="sr-only">Done, not opened yet,</span>
        {when}
      </span>
    )
  }
  return <span className="text-xs text-muted-foreground tabular-nums">{when}</span>
}

/** The mark on the first line: the Holi's face when one ran it, the
 *  automation's bolt, else the provider's. */
function CardMark({ row }: { row: SessionRow }): React.JSX.Element {
  const by = row.item.by
  if (by?.kind === 'holi' && by.mascot !== undefined) {
    return (
      <PixelPersona
        name={by.mascot}
        color={by.color ?? DEFAULT_HOLI_COLOUR}
        status={row.state === 'done' ? 'idle' : row.state}
        still={row.state === 'idle' || row.state === 'done'}
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
  return <AgentMark agent={row.item.agent} className="size-3.5" />
}

function stateWords(row: SessionRow): string {
  switch (row.state) {
    case 'needs-you':
      return row.item.waitingFor === undefined ? 'needs you' : `needs you: ${row.item.waitingFor}`
    case 'working':
      return 'working'
    case 'done':
      return 'done, not opened yet'
    default:
      return ''
  }
}

/** What a row selects as a tab of its own, if it can be one: its slot's
 *  selection, or a live session of the agent's. */
export function rowSelection(
  item: SessionRow['item'],
  isLive: boolean,
): { owner: string; id: string } | undefined {
  return (
    item.selection ??
    (isLive && item.jobId !== undefined
      ? { owner: 'agent', id: `session:${item.jobId}` }
      : undefined)
  )
}

/** The tab a row drags as, or null for one that opens none. */
export function tabOf(
  item: SessionRow['item'],
  live: readonly { id: string }[],
): { kind: 'session'; owner: string; id: string } | null {
  const isLive = item.jobId !== undefined && live.some((s) => s.id === item.jobId)
  const selection = rowSelection(item, isLive)
  return selection === undefined ? null : { kind: 'session', ...selection }
}

/**
 * A session in two lines: the title with the state or age on the right, then
 * who ran it (the mark and the model) and where. The title is the only line
 * in the foreground; the vault is left out, since every card is in this one.
 */
export function SessionCard({
  row,
  now,
  focusable,
  onOpen,
  onFocus,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'onFocus'> & {
  row: SessionRow
  now: number
  focusable: boolean
  onOpen: () => void
  onFocus: () => void
}): React.JSX.Element {
  const { item, state, current } = row
  const by =
    item.by === undefined
      ? ''
      : `${item.by.kind === 'holi' ? 'Holi' : 'Automation'} ${item.by.name}`
  const label = [item.title, stateWords(row), by].filter(Boolean).join(', ')
  const meta = [
    item.by === undefined ? undefined : item.by.name,
    modelLabel(item.model),
    item.location,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Button
      {...props}
      variant="ghost"
      type="button"
      data-session-card={item.key}
      data-session-state={state}
      aria-current={current ? 'true' : undefined}
      aria-label={label}
      tabIndex={focusable ? 0 : -1}
      onClick={onOpen}
      onFocus={onFocus}
      className={cn(
        'h-auto w-full min-w-0 justify-start text-start font-normal whitespace-normal',
        // The sidebar's one fill scale, as the rows above and in Documents.
        'hover:bg-foreground/5',
        current && 'bg-foreground/10 hover:bg-foreground/12',
      )}
    >
      <span
        className={cn(
          'flex w-full min-w-0 flex-col gap-0.5 rounded-lg border px-1 py-1.5',
          state === 'needs-you' ? 'border-dashed border-border' : 'border-transparent',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{item.title}</span>
            </TooltipTrigger>
            <TooltipContent side="right">{item.title}</TooltipContent>
          </Tooltip>
          <span className="flex shrink-0 items-center">
            <CardStatus row={row} now={now} />
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <CardMark row={row} />
          <span className="min-w-0 truncate">{meta}</span>
        </span>
      </span>
    </Button>
  )
}
