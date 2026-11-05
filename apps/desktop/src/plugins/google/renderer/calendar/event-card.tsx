/**
 * The event card, from ReUI's `event-calendar-3` block: an anchored card
 * that reads an event, and edits or creates one.
 *
 * Reading shows what Google says about it: when, which calendar, where, the
 * call to join, who organised it and how many are invited, and the invitation
 * itself, which goes down the same sandboxed path a mail body does. Editing
 * and deleting are offered only for an event Holi may change: on the primary
 * calendar with nobody invited, since a change would email them. Any other
 * opens in Google Calendar.
 *
 * Dropped from the block: guests, the calendar select, notes and the booking
 * facts (reference, rate, nights, status). Holi invites nobody, writes only to
 * the primary calendar, and the calls it writes through carry a title, times
 * and, on creation, a place.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/plugin-api'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/composites/confirm-dialog'
import { IconButton } from '@/composites/icon-button'
import {
  CalendarIcon,
  ClipboardListIcon,
  ClockIcon,
  ExternalLinkIcon,
  FileTextIcon,
  InfoIcon,
  MapPinIcon,
  PencilIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
  VideoIcon,
  XIcon,
} from 'lucide-react'
import type { GoogleEventData } from '../calendar-data'
import { descriptionHtml } from '../event-description'
import { SandboxedHtml } from '../sandboxed-html'
import { dayMonth, longDay, timeOf } from './calendar-format'
import { CalendarDot, DateField, TimeSelect } from './event-fields'

/** The edit buffer. Dates are "yyyy-MM-dd", times are "HH:mm". */
export interface EventDraft {
  /** The calendar item's id; absent while creating. */
  key?: string
  /** Google's id, which the writes take. */
  googleId?: string
  title: string
  location: string
  date: string
  /** Inclusive last day. */
  dateEnd: string
  start: string
  end: string
  allDay: boolean
  calendarName: string
  color: string
  /** Everything Google said, for reading; absent while creating. */
  data?: GoogleEventData
}

type EventCardMode = 'view' | 'edit' | 'create'

export interface EventCardState {
  mode: EventCardMode
  draft: EventDraft
  identity: number
}

export interface EventCardAnchor {
  rect: DOMRect
  element: HTMLElement | null
  fallback?: HTMLElement | null
}

interface EventCardProps {
  state: EventCardState | null
  anchor: EventCardAnchor | null
  error: string | null
  saving: boolean
  /** Offered only in a vault that runs tasks. */
  canCreateTask: boolean
  onOpenChange: (open: boolean) => void
  onEdit: () => void
  /** Save what the form holds: the draft it was opened with, as edited. */
  onSave: (draft: EventDraft) => void
  onDelete: () => Promise<void>
  onCreateTask: () => Promise<void>
  onOpenExternal: (url: string) => void
}

const toDate = (day: string, time: string) => new Date(`${day}T${time}:00`)

/** ReUI inline dot separator between two rendered segments. */
function Dot() {
  return <span aria-hidden="true" className="bg-muted-foreground/40 size-1 shrink-0 rounded-full" />
}

/** The "when" split into a date part and (for timed events) a time-range part,
 *  respecting all-day + multi-day spans. */
function whenParts(draft: EventDraft): { date: string; time: string | null } {
  const start = toDate(draft.date, draft.allDay ? '00:00' : draft.start)
  const sameDay = draft.date === draft.dateEnd
  if (draft.allDay) {
    return {
      date: sameDay
        ? longDay(start)
        : `${dayMonth(start)} - ${dayMonth(toDate(draft.dateEnd, '00:00'))}`,
      time: null,
    }
  }
  const end = toDate(draft.dateEnd, draft.end)
  if (!sameDay) {
    return {
      date: `${dayMonth(start)}, ${timeOf(start)} - ${dayMonth(end)}, ${timeOf(end)}`,
      time: null,
    }
  }
  return { date: longDay(start), time: `${timeOf(start)} - ${timeOf(end)}` }
}

/** Inclusive all-day span in days. */
function allDayDays(draft: EventDraft): number {
  const start = new Date(`${draft.date}T00:00:00`)
  const end = new Date(`${draft.dateEnd}T00:00:00`)
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
}

/** Timed duration, e.g. "1h 30m". */
function durationLabel(draft: EventDraft): string {
  const start = toDate(draft.date, draft.start)
  const end = toDate(draft.dateEnd, draft.end)
  const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000))
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  if (hours && rest) return `${hours}h ${rest}m`
  if (hours) return `${hours}h`
  return `${rest}m`
}

/** What a non-meeting block is. An ordinary meeting is the baseline. */
const KIND_LABELS: Partial<Record<GoogleEventData['kind'], string>> = {
  outOfOffice: 'Out of office',
  focusTime: 'Focus time',
  birthday: 'Birthday',
}

/** The clock detail: a strong date/time line, then a muted meta line (all-day
 *  or duration, recurrence, free time) with dot separators between segments. */
function WhenDetail({ draft }: { draft: EventDraft }) {
  const parts = whenParts(draft)
  const days = draft.allDay ? allDayDays(draft) : 0
  const meta = [
    draft.data?.recurring ? 'Repeats' : null,
    draft.data !== undefined && !draft.data.busy ? 'Free: doesn’t block time' : null,
    draft.data !== undefined ? (KIND_LABELS[draft.data.kind] ?? null) : null,
  ].filter((part): part is string => part !== null)
  return (
    <>
      <div className="text-foreground flex flex-wrap items-center gap-x-1.5">
        <span>{parts.date}</span>
        {parts.time && (
          <>
            <Dot />
            <span>{parts.time}</span>
          </>
        )}
      </div>
      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-1.5 text-xs">
        <span>{draft.allDay ? 'All day' : durationLabel(draft)}</span>
        {draft.allDay && days > 1 && (
          <>
            <Dot />
            <span>{days} days</span>
          </>
        )}
        {meta.map((part) => (
          <span key={part} className="contents">
            <Dot />
            <span>{part}</span>
          </span>
        ))}
      </div>
    </>
  )
}

export function EventCard({
  state,
  anchor,
  error,
  saving,
  canCreateTask,
  onOpenChange,
  onEdit,
  onSave,
  onDelete,
  onCreateTask,
  onOpenExternal,
}: EventCardProps) {
  const virtualRef = useMemo(() => {
    const initialElementRect = anchor?.element?.getBoundingClientRect()
    const point =
      anchor?.rect.width === 1 && initialElementRect
        ? { x: anchor.rect.x - initialElementRect.x, y: anchor.rect.y - initialElementRect.y }
        : null
    return {
      current: {
        contextElement: anchor?.element ?? undefined,
        getBoundingClientRect: () => {
          if (!anchor?.element?.isConnected) return anchor?.rect ?? new DOMRect()
          const rect = anchor.element.getBoundingClientRect()
          return point
            ? new DOMRect(rect.x + Math.min(point.x, rect.width), rect.y + point.y, 1, 1)
            : rect
        },
      },
    }
  }, [anchor])
  const escapeClose = useRef(false)
  const explicitClose = useRef(false)
  const isForm = state?.mode === 'edit' || state?.mode === 'create'
  const label = isForm ? (state?.mode === 'edit' ? 'Edit event' : 'New event') : state?.draft.title
  return (
    <Popover open={state !== null && anchor !== null} onOpenChange={onOpenChange}>
      {anchor && <PopoverAnchor virtualRef={virtualRef} />}
      {state && anchor && (
        <PopoverContent
          size="calendar"
          variant="flush"
          align="start"
          side={anchor && anchor.rect.y > window.innerHeight / 2 ? 'top' : 'bottom'}
          aria-label={label || 'Event details'}
          aria-busy={saving}
          onOpenAutoFocus={(event) => {
            escapeClose.current = false
            event.preventDefault()
            const content = event.currentTarget as HTMLElement
            if (isForm) content.querySelector<HTMLInputElement>('#event-title')?.focus()
            else content.querySelector<HTMLElement>('[data-event-card-focus]')?.focus()
          }}
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault()
            else escapeClose.current = true
          }}
          onCloseAutoFocus={(event) => {
            const origin = anchor.element
            const target =
              origin?.isConnected &&
              origin.matches('button:not(:disabled),a[href],input:not(:disabled),[tabindex]')
                ? origin
                : anchor.fallback
            if ((escapeClose.current || explicitClose.current) && target?.isConnected) {
              event.preventDefault()
              target.focus()
            }
            escapeClose.current = false
            explicitClose.current = false
          }}
        >
          <span role="status" className="sr-only">
            {saving ? 'Working…' : ''}
          </span>
          {isForm ? (
            <EventForm
              key={state.identity}
              draft={state.draft}
              mode={state.mode as 'edit' | 'create'}
              error={error}
              saving={saving}
              onSave={onSave}
              onDelete={onDelete}
              onClose={() => {
                explicitClose.current = true
                onOpenChange(false)
              }}
            />
          ) : (
            <EventView
              draft={state.draft}
              error={error}
              canCreateTask={canCreateTask}
              saving={saving}
              onEdit={onEdit}
              onDelete={onDelete}
              onCreateTask={onCreateTask}
              onOpenExternal={onOpenExternal}
              onClose={() => {
                explicitClose.current = true
                onOpenChange(false)
              }}
            />
          )}
        </PopoverContent>
      )}
    </Popover>
  )
}

/** Header close button, shared by view + form. */
function CloseButton({ onClose, disabled }: { onClose: () => void; disabled: boolean }) {
  return (
    <IconButton
      type="button"
      label="Close"
      className="-me-1 shrink-0"
      onClick={onClose}
      disabled={disabled}
    >
      <XIcon className="size-4" aria-hidden="true" />
    </IconButton>
  )
}

/** A labeled detail row for the view mode: fixed-width icon gutter + content. */
function DetailRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="text-muted-foreground flex size-4 shrink-0 items-center justify-center [&_svg]:size-4"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  )
}

function EventView({
  draft,
  error,
  canCreateTask,
  saving,
  onEdit,
  onDelete,
  onCreateTask,
  onOpenExternal,
  onClose,
}: {
  draft: EventDraft
  error: string | null
  canCreateTask: boolean
  saving: boolean
  onEdit: () => void
  onDelete: () => Promise<void>
  onCreateTask: () => Promise<void>
  onOpenExternal: (url: string) => void
  onClose: () => void
}) {
  const data = draft.data
  const editable = data?.editable === true
  return (
    <TooltipProvider>
      {/* Header: title + state badges share one line. The calendar color is
          shown in the Calendar detail row below, not repeated here. */}
      <div className="flex shrink-0 items-center gap-2.5 border-b px-5 py-3">
        <PopoverTitle
          data-event-card-focus
          tabIndex={-1}
          className="min-w-0 shrink truncate text-lg leading-tight font-semibold"
        >
          {draft.title}
        </PopoverTitle>
        <PopoverDescription className="sr-only">Event details.</PopoverDescription>
        {draft.allDay && (
          <Badge variant="outline" className="shrink-0">
            All day
          </Badge>
        )}
        {data?.myResponse === 'needsAction' && (
          <Badge variant="warning-light" className="shrink-0">
            Invited
          </Badge>
        )}
        {data?.myResponse === 'tentative' && (
          <Badge variant="info-light" className="shrink-0">
            Maybe
          </Badge>
        )}
        {/* spacer keeps the badges next to the title and the close at the edge */}
        <div aria-hidden="true" className="flex-1" />
        {data && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={() => onOpenExternal(data.htmlLink)}
              >
                <ExternalLinkIcon className="size-4" aria-hidden="true" />
                <span className="sr-only">Open in Google Calendar</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open in Google Calendar</TooltipContent>
          </Tooltip>
        )}
        <CloseButton onClose={onClose} disabled={saving} />
      </div>

      {/* Details */}
      <div className="flex min-h-0 flex-1">
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-4 px-5 py-5">
            <DetailRow icon={<ClockIcon />}>
              <WhenDetail draft={draft} />
            </DetailRow>

            <DetailRow icon={<CalendarIcon />}>
              <div className="flex items-center gap-2">
                <CalendarDot color={draft.color} />
                <span className="text-foreground truncate">{draft.calendarName}</span>
                {data?.mine === false && (
                  <span className="text-muted-foreground shrink-0 text-xs">Subscribed</span>
                )}
              </div>
            </DetailRow>

            {data?.conferenceUrl && (
              <DetailRow icon={<VideoIcon />}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenExternal(data.conferenceUrl!)}
                >
                  Join the call
                </Button>
              </DetailRow>
            )}

            {draft.location && (
              <DetailRow icon={<MapPinIcon />}>
                <p className="text-foreground break-words">{draft.location}</p>
              </DetailRow>
            )}

            {data?.organizer && (
              <DetailRow icon={<UserIcon />}>
                <span className="text-foreground truncate">{data.organizer}</span>
              </DetailRow>
            )}

            {data !== undefined && data.attendeeCount > 1 && (
              <DetailRow icon={<UsersIcon />}>
                <span className="text-muted-foreground text-xs">{data.attendeeCount} people</span>
              </DetailRow>
            )}

            {data?.description && data.description.trim() !== '' && (
              <div className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="text-muted-foreground flex size-4 shrink-0 items-center justify-center pt-0.5 [&_svg]:size-4"
                >
                  <FileTextIcon />
                </span>
                {/* Whoever sent the invitation wrote this, so all of it goes
                    down the same sandboxed path a mail body does. */}
                <div className="min-w-0 flex-1">
                  <SandboxedHtml
                    html={descriptionHtml(data.description)}
                    label={`description of ${draft.title}`}
                  />
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Actions */}
      <div className="bg-muted flex shrink-0 items-center gap-2 border-t px-5 py-3">
        {editable && <DeleteEventButton onDelete={onDelete} disabled={saving} />}
        {!editable && data !== undefined && (
          <p className="text-muted-foreground min-w-0 text-xs">
            {data.attendeeCount > 0
              ? 'Has guests: change it in Google Calendar, which emails them.'
              : 'Not on your calendar: change it in Google Calendar.'}
          </p>
        )}
        <div aria-hidden="true" className="flex-1" />
        {canCreateTask && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void onCreateTask()}
            disabled={saving}
          >
            <ClipboardListIcon className="size-4" aria-hidden="true" />
            Task
          </Button>
        )}
        {editable ? (
          <Button type="button" onClick={onEdit} disabled={saving}>
            <PencilIcon className="size-4" aria-hidden="true" />
            Edit
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Close
          </Button>
        )}
      </div>
    </TooltipProvider>
  )
}

/**
 * The form owns its edit buffer, so a keystroke re-renders the form and not
 * the calendar behind it: held by the view, every key re-rendered the week
 * grid and the rail.
 */
function EventForm({
  draft: initial,
  mode,
  error,
  saving,
  onSave: save,
  onDelete,
  onClose,
}: {
  draft: EventDraft
  mode: 'edit' | 'create'
  error: string | null
  saving: boolean
  onSave: (draft: EventDraft) => void
  onDelete: () => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const patch = useCallback(
    (partial: Partial<EventDraft>) => setDraft((prev) => ({ ...prev, ...partial })),
    [],
  )
  // Stable, so the memoised time selects skip a keystroke in the title.
  const setStart = useCallback((start: string) => patch({ start }), [patch])
  const setEnd = useCallback((end: string) => patch({ end }), [patch])
  const onSave = () => save(draft)
  return (
    <TooltipProvider>
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b px-5 py-3">
        <PopoverTitle className="flex-1 text-base font-semibold">
          {mode === 'edit' ? 'Edit event' : 'New event'}
        </PopoverTitle>
        <PopoverDescription className="sr-only">
          {mode === 'edit' ? 'Change this event.' : 'Add an event to your own calendar.'}
        </PopoverDescription>
        <CloseButton onClose={onClose} disabled={saving} />
      </div>

      {/* Form body */}
      <div className="flex min-h-0 flex-1">
        <ScrollArea className="flex-1">
          {/* Enter in a text field saves, as a form would. */}
          <div
            className="flex flex-col gap-5 px-5 py-5"
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.nativeEvent.isComposing &&
                event.target instanceof HTMLInputElement &&
                !saving
              ) {
                event.preventDefault()
                onSave()
              }
            }}
          >
            <Field>
              <FieldLabel htmlFor="event-title">Title</FieldLabel>
              <Input
                id="event-title"
                autoFocus
                value={draft.title}
                onChange={(event) => patch({ title: event.target.value })}
                disabled={saving}
                placeholder="Title"
                autoComplete="off"
              />
            </Field>

            <Field>
              <FieldLabel>Calendar</FieldLabel>
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <CalendarDot color={draft.color} />
                <span className="truncate">{draft.calendarName}</span>
              </div>
              <FieldDescription>
                {mode === 'create'
                  ? 'Added to your own calendar. Nobody is invited, so nobody is emailed.'
                  : draft.data?.recurring
                    ? 'Changes this occurrence only.'
                    : 'Nobody is invited, so nobody is emailed.'}
              </FieldDescription>
            </Field>

            <Field orientation="horizontal">
              <FieldLabel htmlFor="event-all-day">
                All day
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      aria-label="About all-day events"
                      className="text-muted-foreground/70 hover:text-muted-foreground focus-visible:ring-ring inline-flex cursor-help rounded-full outline-none focus-visible:ring-2"
                    >
                      <InfoIcon className="size-3.5" aria-hidden="true" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-56">
                    All-day events span whole days. They show in the all-day row and as bars across
                    the month view.
                  </TooltipContent>
                </Tooltip>
              </FieldLabel>
              <Switch
                id="event-all-day"
                checked={draft.allDay}
                onCheckedChange={(checked: boolean) => patch({ allDay: checked })}
                disabled={saving}
              />
            </Field>

            <div className="flex gap-3">
              <Field className="min-w-0 flex-1">
                <FieldLabel htmlFor="event-start-date">Starts</FieldLabel>
                <DateField
                  id="event-start-date"
                  value={draft.date}
                  disabled={saving}
                  onSelect={(date) =>
                    patch({ date, dateEnd: draft.dateEnd < date ? date : draft.dateEnd })
                  }
                />
              </Field>
              <Field className="min-w-0 flex-1">
                <FieldLabel htmlFor="event-end-date">Ends</FieldLabel>
                <DateField
                  id="event-end-date"
                  value={draft.dateEnd}
                  disabled={saving}
                  onSelect={(dateEnd) => patch({ dateEnd })}
                />
              </Field>
            </div>

            {!draft.allDay && (
              <div className="flex gap-3">
                <Field className="min-w-0 flex-1">
                  <FieldLabel htmlFor="event-start-time">From</FieldLabel>
                  <TimeSelect
                    id="event-start-time"
                    value={draft.start}
                    disabled={saving}
                    onChange={setStart}
                  />
                </Field>
                <Field className="min-w-0 flex-1">
                  <FieldLabel htmlFor="event-end-time">To</FieldLabel>
                  <TimeSelect
                    id="event-end-time"
                    value={draft.end}
                    disabled={saving}
                    onChange={setEnd}
                  />
                </Field>
              </div>
            )}

            {/* A place is set when the event is made; moving one keeps it. */}
            {mode === 'create' && (
              <Field>
                <FieldLabel htmlFor="event-location">Location</FieldLabel>
                <Input
                  id="event-location"
                  value={draft.location}
                  onChange={(event) => patch({ location: event.target.value })}
                  disabled={saving}
                  placeholder="Location"
                  autoComplete="off"
                />
              </Field>
            )}

            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Actions */}
      <div className="bg-muted flex shrink-0 items-center gap-2 border-t px-5 py-3">
        {mode === 'edit' && (
          <DeleteEventButton onDelete={onDelete} disabled={saving} className="me-auto" />
        )}
        <Button
          type="button"
          variant="outline"
          className={cn(mode === 'create' && 'ms-auto')}
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button type="button" onClick={onSave} disabled={saving}>
          {saving
            ? 'Saving…'
            : error && error !== 'Give it a title.' && error !== 'It has to end after it starts.'
              ? 'Retry'
              : mode === 'edit'
                ? 'Save'
                : 'Add event'}
        </Button>
      </div>
    </TooltipProvider>
  )
}

/** The Delete button, which asks before it deletes. */
function DeleteEventButton({
  onDelete,
  className,
  disabled,
}: {
  onDelete: () => Promise<void>
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className={className}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon className="size-4" aria-hidden="true" />
        Delete
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete event?"
        description="It moves to the bin in Google Calendar, where it can be restored."
        confirmLabel="Delete"
        destructive
        onConfirm={onDelete}
      />
    </>
  )
}
