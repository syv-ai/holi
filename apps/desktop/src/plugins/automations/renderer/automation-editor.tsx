/**
 * One automation, after MonoCode's automation editor (MIT, Copyright (c) 2026
 * Nick; see ../../holis/NOTICE.md), top to bottom:
 *
 * - Its name, with Cancel or Reset, Run now and Create or Save; under it the
 *   Active switch (runs on this machine) and who carries it out (`HoliPicker`).
 * - **Triggers**: each a sentence ("Every weekday at [11:00]"), the time zone
 *   and the next run; Add trigger. A cron no sentence says stays as written.
 *   The events that start it (`on:`) are sentences too ("When a file is
 *   [added] in [inbox/**]"), read and written the way main runs them.
 * - **Instructions**: the prompt, with its model and what it may do without
 *   asking under it.
 * - **Advanced**: the catch-up window for missed runs.
 * - **Run history**, for one that exists.
 *
 * Writing it approves nothing: Active is the approval (`schedules.enable`, at
 * the UI door), sent the fingerprint of what was just written or shown, so it
 * approves exactly that. With a Holi, that covers the Holi's soul and rules
 * too; a change to either reads Changed and waits to be turned on again.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import {
  CalendarClock,
  ChevronDown,
  Clock,
  Ellipsis,
  FileText,
  ListTodo,
  Mail,
  Play,
  Plus,
  ShieldCheck,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { activeRemoteAtom, cn } from '@/plugin-api'
import {
  CronError,
  cronOfTrigger,
  nextCronTime,
  parseCron,
  parseTriggers,
  triggerOfCron,
  triggerYaml,
  type ScheduleTrigger,
  type Trigger,
} from '@holi/shared'
import { HoliPicker } from './holi-picker'
import { schedulesCap, selectAutomationAtom, type ScheduleSummary } from './state'
import type { RunRecord } from './schedules-cap'
import { EmptyState } from '@/composites/empty-state'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Frame, FramePanel } from '@/components/reui/frame'
import { IconButton } from '@/composites/icon-button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

/** What the editor holds while it is open. */
export interface Draft {
  name: string
  active: boolean
  triggers: ScheduleTrigger[]
  /** The events that start it, the file's `on:`. */
  on: Trigger[]
  holi?: string
  model?: string
  allow: string[]
  catchUpMinutes?: number
  prompt: string
}

/** A new automation, after MonoCode's defaults: weekdays at 09:00, active. */
function blankDraft(holi?: string): Draft {
  return {
    name: '',
    active: true,
    triggers: [{ kind: 'weekdays', time: '09:00' }],
    on: [],
    ...(holi === undefined ? {} : { holi }),
    allow: [],
    prompt: '',
  }
}

/** @public exported for its test */
export function draftOf(s: ScheduleSummary): Draft {
  return {
    name: s.name,
    active: s.status === 'on',
    triggers: (s.crons ?? []).map(triggerOfCron),
    on: s.on ?? [],
    ...(s.holi === undefined ? {} : { holi: s.holi }),
    ...(s.model === undefined ? {} : { model: s.model }),
    allow: s.allow ?? [],
    ...(s.catchUpMinutes === undefined ? {} : { catchUpMinutes: s.catchUpMinutes }),
    prompt: s.prompt ?? '',
  }
}

const same = (a: Draft, b: Draft): boolean => JSON.stringify(a) === JSON.stringify(b)

const pad = (n: number): string => String(n).padStart(2, '0')
/** Every half hour of the day, as MonoCode offers them. */
const TIMES = Array.from(
  { length: 48 },
  (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`,
)
const MINUTES = [0, 15, 30, 45]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const MODELS = [
  { value: 'default', label: 'Default model' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

/** How late a missed run may still start. Absent in the file: always, once. */
const CATCH_UP = [
  { value: 'always', label: 'Always, once' },
  { value: '0', label: 'Do not catch up' },
  { value: '30', label: '30 minutes' },
  { value: '120', label: '2 hours' },
  { value: '720', label: '12 hours' },
  { value: '1440', label: '24 hours' },
]

/** `GMT+2`: this machine's offset, which every trigger reads. */
function gmtLabel(): string {
  const minutes = -new Date().getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '−'
  const h = Math.floor(Math.abs(minutes) / 60)
  const m = Math.abs(minutes) % 60
  return `GMT${sign}${h}${m === 0 ? '' : `:${pad(m)}`}`
}

const nextFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** The trigger's cron, or why it does not read. */
function cronFor(t: ScheduleTrigger): { cron: string; error?: string } {
  const cron = cronOfTrigger(t)
  try {
    parseCron(cron)
    return { cron }
  } catch (err) {
    return { cron, error: err instanceof CronError ? err.message : String(err) }
  }
}

function nextOf(t: ScheduleTrigger): string | null {
  try {
    const next = nextCronTime(parseCron(cronOfTrigger(t)), new Date())
    return next === null ? null : nextFormat.format(next)
  } catch {
    return null
  }
}

/** A small select in a sentence, after MonoCode's pill selects. */
function Pill({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} className="w-auto">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const KINDS: { value: ScheduleTrigger['kind']; label: string }[] = [
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'weekly', label: 'Every week' },
  { value: 'custom', label: 'On a cron' },
]

/** A trigger of another kind, keeping its time where it has one. */
function retype(t: ScheduleTrigger, kind: ScheduleTrigger['kind']): ScheduleTrigger {
  const time = 'time' in t ? t.time : '09:00'
  if (kind === 'hourly') return { kind, minute: 0 }
  if (kind === 'weekly') return { kind, day: 1, time }
  if (kind === 'custom') return { kind, cron: cronOfTrigger(t) }
  return { kind, time }
}

function TriggerRow({
  trigger,
  onChange,
  onRemove,
}: {
  trigger: ScheduleTrigger
  onChange: (t: ScheduleTrigger) => void
  onRemove: () => void
}): React.JSX.Element {
  const next = nextOf(trigger)
  const error = cronFor(trigger).error
  const times = TIMES.map((t) => ({ value: t, label: t }))
  const withTime =
    'time' in trigger && !TIMES.includes(trigger.time)
      ? [{ value: trigger.time, label: trigger.time }, ...times]
      : times
  return (
    <li className="group/trigger flex min-h-10 flex-wrap items-center gap-2 py-1 text-sm">
      <Clock className="size-3.5 text-muted-foreground" />
      <Pill
        label="How often"
        value={trigger.kind}
        options={KINDS}
        onChange={(k) => onChange(retype(trigger, k as ScheduleTrigger['kind']))}
      />
      {trigger.kind === 'hourly' && (
        <>
          <span className="text-muted-foreground">at</span>
          <Pill
            label="Minute"
            value={String(trigger.minute)}
            options={MINUTES.map((m) => ({ value: String(m), label: `:${pad(m)}` }))}
            onChange={(m) => onChange({ kind: 'hourly', minute: Number(m) })}
          />
        </>
      )}
      {trigger.kind === 'weekly' && (
        <>
          <span className="text-muted-foreground">on</span>
          <Pill
            label="Day"
            value={String(trigger.day)}
            options={DAYS.map((d, i) => ({ value: String(i), label: d }))}
            onChange={(d) => onChange({ ...trigger, day: Number(d) })}
          />
        </>
      )}
      {'time' in trigger && (
        <>
          <span className="text-muted-foreground">at</span>
          <Pill
            label="Time"
            value={trigger.time}
            options={withTime}
            onChange={(time) => onChange({ ...trigger, time })}
          />
        </>
      )}
      {trigger.kind === 'custom' && (
        <Input
          aria-label="Cron"
          aria-invalid={error !== undefined}
          className="w-48 font-mono text-xs"
          value={trigger.cron}
          onChange={(e) => onChange({ kind: 'custom', cron: e.target.value })}
        />
      )}
      <span className="text-xs text-muted-foreground">{gmtLabel()}</span>
      <span className="text-xs text-muted-foreground">
        {error !== undefined ? error : next === null ? '' : `Next run ${next}`}
      </span>
      <span className="ms-auto opacity-0 focus-within:opacity-100 group-hover/trigger:opacity-100">
        <IconButton label="Remove trigger" size="icon-xs" onClick={onRemove}>
          <X />
        </IconButton>
      </span>
    </li>
  )
}

/** The events an automation can start on, for Add trigger, with a first
 *  value each that reads. */
const EVENTS: { label: string; trigger: Trigger }[] = [
  { label: 'When a file arrives', trigger: { source: 'file', glob: 'inbox/**', changed: false } },
  { label: 'When a task is due', trigger: { source: 'task', when: 'due', before: 0 } },
  { label: 'Before a calendar event', trigger: { source: 'calendar', before: 30 } },
  { label: 'When mail arrives', trigger: { source: 'mail', query: 'from:' } },
]

const EVENT_ICON: Record<Trigger['source'], LucideIcon> = {
  file: FileText,
  task: ListTodo,
  calendar: CalendarClock,
  mail: Mail,
}

/** How long before, as the sources offer it; a lead the file names that is
 *  not here is offered as written. */
const LEADS = [0, 5, 15, 30, 60, 120, 1440]

function leadLabel(minutes: number, zero: string): string {
  if (minutes === 0) return zero
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'} before`
  if (minutes % 60 === 0) return `${minutes / 60} h before`
  return `${minutes} min before`
}

function leadOptions(current: number, zero: string): { value: string; label: string }[] {
  const all = LEADS.includes(current) ? LEADS : [...LEADS, current].sort((a, b) => a - b)
  return all.map((m) => ({ value: String(m), label: leadLabel(m, zero) }))
}

/** Why a trigger does not read, the way main would refuse it. */
function eventError(t: Trigger): string | undefined {
  const parsed = parseTriggers([triggerYaml(t)])
  return parsed.ok ? undefined : parsed.error.replace(/^on: /, '')
}

/** One `on:` trigger as a sentence: "When a file is [added] in [inbox/**]". */
function EventRow({
  trigger,
  onChange,
  onRemove,
}: {
  trigger: Trigger
  onChange: (t: Trigger) => void
  onRemove: () => void
}): React.JSX.Element {
  const error = eventError(trigger)
  const EventIcon = EVENT_ICON[trigger.source]
  const muted = (text: string) => <span className="text-muted-foreground">{text}</span>
  return (
    <li
      className="group/trigger flex min-h-10 flex-wrap items-center gap-2 py-1 text-sm"
      data-event-trigger={trigger.source}
    >
      <EventIcon className="size-3.5 text-muted-foreground" />
      {trigger.source === 'file' && (
        <>
          {muted('When a file is')}
          <Pill
            label="Which files"
            value={trigger.changed ? 'changed' : 'added'}
            options={[
              { value: 'added', label: 'added' },
              { value: 'changed', label: 'added or changed' },
            ]}
            onChange={(v) => onChange({ ...trigger, changed: v === 'changed' })}
          />
          {muted('in')}
          <Input
            aria-label="Folder or files"
            aria-invalid={error !== undefined}
            className="w-48 font-mono text-xs"
            value={trigger.glob}
            onChange={(e) => onChange({ ...trigger, glob: e.target.value })}
          />
        </>
      )}
      {trigger.source === 'task' && (
        <>
          {muted('When a task is')}
          <Pill
            label="Task moment"
            value={trigger.when === 'overdue' ? 'overdue' : String(trigger.before)}
            options={[
              ...leadOptions(trigger.when === 'due' ? trigger.before : 0, 'due').map((o) => ({
                ...o,
                label: o.value === '0' ? 'due' : o.label.replace(' before', ' before it is due'),
              })),
              { value: 'overdue', label: 'overdue' },
            ]}
            onChange={(v) =>
              onChange(
                v === 'overdue'
                  ? { source: 'task', when: 'overdue', before: 0 }
                  : { source: 'task', when: 'due', before: Number(v) },
              )
            }
          />
        </>
      )}
      {trigger.source === 'calendar' && (
        <>
          <Pill
            label="How long before"
            value={String(trigger.before)}
            options={leadOptions(trigger.before, 'When').map((o) =>
              o.value === '0' ? { ...o, label: 'As' } : o,
            )}
            onChange={(v) => onChange({ source: 'calendar', before: Number(v) })}
          />
          {muted(trigger.before === 0 ? 'a calendar event starts' : 'each calendar event')}
        </>
      )}
      {trigger.source === 'mail' && (
        <>
          {muted('When new mail matches')}
          <Input
            aria-label="Gmail search"
            aria-invalid={error !== undefined}
            className="w-56 font-mono text-xs"
            value={trigger.query}
            onChange={(e) => onChange({ source: 'mail', query: e.target.value })}
          />
        </>
      )}
      {error !== undefined && <span className="text-xs text-destructive">{error}</span>}
      <span className="ms-auto opacity-0 focus-within:opacity-100 group-hover/trigger:opacity-100">
        <IconButton label="Remove trigger" size="icon-xs" onClick={onRemove}>
          <X />
        </IconButton>
      </span>
    </li>
  )
}

/** What it may do without asking, one rule a line, in a pill's popover. */
function AllowPill({
  allow,
  onChange,
}: {
  allow: string[]
  onChange: (allow: string[]) => void
}): React.JSX.Element {
  const [text, setText] = useState(allow.join('\n'))
  return (
    <Popover onOpenChange={(open) => open && setText(allow.join('\n'))}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="xs">
          <ShieldCheck className="size-3.5" />
          {allow.length === 0 ? 'Asks for everything' : `${allow.length} allowed`}
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <p className="text-xs text-muted-foreground">
          Claude Code rules it may use without asking, one a line. Name the folders it writes:{' '}
          <code className="font-mono">Edit(tilbud/**)</code>, never a bare Edit. Everything else
          asks you.
        </p>
        <Textarea
          aria-label="Allowed without asking"
          className="min-h-28 font-mono text-xs"
          placeholder={'Bash(holi google read:*)\nEdit(**/task.*.md)'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() =>
            onChange(
              text
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l !== ''),
            )
          }
        />
      </PopoverContent>
    </Popover>
  )
}

const runFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

function duration(from: string, to: string | undefined): string {
  if (to === undefined) return ''
  const minutes = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000)
  if (minutes < 1) return '< 1m'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function RunHistory({ runs }: { runs: readonly RunRecord[] }): React.JSX.Element {
  if (runs.length === 0) {
    return <EmptyState icon={Clock} title="It has not run yet" />
  }
  return (
    <ul aria-label="Run history" className="flex flex-col divide-y divide-divider">
      {runs.map((r, i) => (
        <li key={`${r.at}-${i}`} className="flex min-h-11 items-center gap-3 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {r.trigger === 'manual' ? 'Run now' : r.trigger === 'event' ? 'Event' : 'Scheduled'}
            {r.trigger === 'event' && r.cause !== undefined && (
              <span className="text-muted-foreground"> · {r.cause}</span>
            )}
            {r.message !== undefined && (
              <span className="text-muted-foreground"> · {r.message}</span>
            )}
          </span>
          <span className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">
            {runFormat.format(new Date(r.at))}
          </span>
          <span className="w-24 shrink-0">
            <Badge
              variant={
                r.outcome === 'failed'
                  ? 'destructive-light'
                  : r.outcome === 'started'
                    ? 'primary-light'
                    : 'outline'
              }
            >
              {r.outcome === 'started'
                ? r.finishedAt === undefined
                  ? 'Running'
                  : 'Finished'
                : r.outcome === 'failed'
                  ? 'Failed'
                  : 'Skipped'}
            </Badge>
          </span>
          <span className="w-14 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
            {duration(r.at, r.finishedAt)}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function AutomationEditor({
  summary,
  initial,
}: {
  /** The automation as main reads it; absent for a new one. */
  summary?: ScheduleSummary
  initial: Draft
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const select = useSetAtom(selectAutomationAtom)
  const [draft, setDraft] = useState<Draft>(initial)
  // Main read it again (a save, a run, a pull): follow it, unless something
  // is typed over what was there.
  const shown = useRef(initial)
  useEffect(() => {
    if (same(draft, shown.current)) setDraft(initial)
    shown.current = initial
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [removing, setRemoving] = useState(false)
  const dirty = !same(draft, initial)
  const isNew = summary === undefined
  const triggerErrors = [
    ...draft.triggers.map((t) => cronFor(t).error),
    ...draft.on.map(eventError),
  ].filter(Boolean)
  const triggerCount = draft.triggers.length + draft.on.length
  const canSave =
    draft.name.trim() !== '' &&
    draft.prompt.trim() !== '' &&
    triggerCount > 0 &&
    triggerErrors.length === 0 &&
    (isNew || dirty)

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err))

  async function apply(fn: () => Promise<void>) {
    if (remote === null) return
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  /** Write the file, then make Active true of it: turning on approves what
   *  was just written, by the fingerprint main answered with. */
  const save = () =>
    apply(async () => {
      const saved = await schedulesCap.save(remote!, {
        ...(summary === undefined ? {} : { path: summary.path }),
        draft: {
          name: draft.name.trim(),
          crons: draft.triggers.map((t) => cronOfTrigger(t)),
          on: draft.on,
          prompt: draft.prompt,
          allow: draft.allow,
          ...(draft.holi === undefined ? {} : { holi: draft.holi }),
          ...(draft.model === undefined ? {} : { model: draft.model }),
          ...(draft.catchUpMinutes === undefined ? {} : { catchUpMinutes: draft.catchUpMinutes }),
        },
      })
      if (draft.active && saved.status !== 'on' && saved.fingerprint !== undefined) {
        await schedulesCap.enable(remote!, {
          schedule: saved.path,
          fingerprint: saved.fingerprint,
        })
      } else if (!draft.active && saved.status === 'on') {
        await schedulesCap.disable(remote!, { schedule: saved.path })
      }
      select(saved.path)
    })

  /** The switch on a saved, unchanged automation acts at once; otherwise it
   *  is part of what Save writes. */
  const toggle = (on: boolean) => {
    set({ active: on })
    if (summary === undefined || dirty) return
    void apply(async () => {
      if (on) {
        if (summary.fingerprint === undefined) throw new Error(summary.error ?? 'It cannot run.')
        await schedulesCap.enable(remote!, {
          schedule: summary.path,
          fingerprint: summary.fingerprint,
        })
      } else await schedulesCap.disable(remote!, { schedule: summary.path })
    })
  }

  const header = (
    <div className="flex shrink-0 flex-col gap-2.5 border-b border-divider">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-2.5 px-8 pt-5 pb-4">
        <div className="flex items-start gap-6">
          <Input
            autoFocus={isNew}
            aria-label="Automation name"
            placeholder="Untitled"
            className="min-w-0 flex-1 bg-transparent text-xl font-semibold tracking-tight"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {(isNew || dirty) && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => (isNew ? select('list') : setDraft(initial))}
              >
                {isNew ? 'Cancel' : 'Reset'}
              </Button>
            )}
            {!isNew && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || summary.status !== 'on' || dirty}
                onClick={() =>
                  void apply(async () => {
                    await schedulesCap.run(remote!, { schedule: summary.path })
                  })
                }
              >
                <Play className="size-3.5" />
                Run now
              </Button>
            )}
            <Button size="sm" disabled={busy || !canSave} onClick={() => void save()}>
              {isNew ? 'Create' : 'Save'}
            </Button>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={draft.active}
            aria-label="Active on this machine"
            disabled={busy}
            onCheckedChange={toggle}
          />
          <span>
            {summary?.status === 'changed' && !dirty
              ? 'Changed: turn it on again to approve'
              : draft.active
                ? 'Active'
                : 'Inactive'}
          </span>
          <span aria-hidden="true" className="ms-2 h-3 w-px bg-divider" />
          <HoliPicker
            value={draft.holi}
            onChange={(holi) =>
              setDraft(({ holi: _old, ...d }) => (holi === undefined ? d : { ...d, holi }))
            }
          />
          {!isNew && (
            <>
              <span aria-hidden="true" className="h-3 w-px bg-divider" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label="More" size="icon-xs">
                    <Ellipsis />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
                    Delete automation…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
        {removing && summary !== undefined && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 text-muted-foreground">
              Delete “{summary.name}”? Its file leaves the vault for everyone; git keeps it.
            </span>
            <Button size="xs" variant="ghost" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void apply(async () => {
                  await schedulesCap.remove(remote!, { schedule: summary.path })
                  select('list')
                })
              }
            >
              Delete
            </Button>
          </div>
        )}
        {(error ?? (summary?.status === 'invalid' ? summary.error : undefined)) !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? summary?.error}
          </p>
        )}
      </div>
    </div>
  )

  const settings = (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-8 py-5 pb-10">
      <section aria-label="Triggers" className="flex flex-col gap-3">
        <h2 className="px-1 text-xs font-medium text-muted-foreground">Triggers</h2>
        <Frame stacked spacing="sm">
          {triggerCount > 0 && (
            <FramePanel>
              <ul className="flex flex-col">
                {draft.triggers.map((t, i) => (
                  <TriggerRow
                    key={i}
                    trigger={t}
                    onChange={(next) =>
                      set({ triggers: draft.triggers.map((x, j) => (j === i ? next : x)) })
                    }
                    onRemove={() => set({ triggers: draft.triggers.filter((_, j) => j !== i) })}
                  />
                ))}
                {draft.on.map((t, i) => (
                  <EventRow
                    key={`on-${i}`}
                    trigger={t}
                    onChange={(next) => set({ on: draft.on.map((x, j) => (j === i ? next : x)) })}
                    onRemove={() => set({ on: draft.on.filter((_, j) => j !== i) })}
                  />
                ))}
              </ul>
            </FramePanel>
          )}
          <FramePanel flush>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="lg"
                  className="w-full justify-start font-normal text-muted-foreground hover:text-foreground"
                  disabled={triggerCount >= 20}
                >
                  <Plus className="size-3.5" />
                  Add trigger
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>On a schedule</DropdownMenuLabel>
                {KINDS.map((k) => (
                  <DropdownMenuItem
                    key={k.value}
                    onSelect={() =>
                      set({
                        triggers: [
                          ...draft.triggers,
                          retype({ kind: 'weekdays', time: '09:00' }, k.value),
                        ],
                      })
                    }
                  >
                    {k.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>On an event</DropdownMenuLabel>
                {EVENTS.map((e) => (
                  <DropdownMenuItem
                    key={e.label}
                    onSelect={() => set({ on: [...draft.on, e.trigger] })}
                  >
                    {e.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </FramePanel>
        </Frame>
        {triggerCount === 0 && (
          <p className="px-1 text-xs text-muted-foreground">
            Add a trigger: an automation runs only when one comes due or happens.
          </p>
        )}
        {summary?.at !== undefined && (
          <p className="px-1 text-xs text-muted-foreground">
            Its file names one moment, {summary.at.replace('T', ' ')}; saving here replaces it with
            these triggers.
          </p>
        )}
      </section>

      <section aria-label="Instructions" className="flex flex-col gap-3">
        <h2 className="px-1 text-xs font-medium text-muted-foreground">Instructions</h2>
        <Frame spacing="sm">
          <FramePanel flush className="flex flex-col">
            <Textarea
              aria-label="Instructions"
              className="min-h-56 resize-y bg-transparent text-sm"
              placeholder="What it should do on each run, and what to leave in the vault for you."
              value={draft.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
              <Select
                value={draft.model ?? 'default'}
                onValueChange={(v) =>
                  setDraft(({ model: _old, ...d }) => (v === 'default' ? d : { ...d, model: v }))
                }
              >
                <SelectTrigger size="sm" aria-label="Model" className="w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    ...MODELS,
                    ...(draft.model !== undefined && !MODELS.some((m) => m.value === draft.model)
                      ? [{ value: draft.model, label: draft.model }]
                      : []),
                  ].map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AllowPill allow={draft.allow} onChange={(allow) => set({ allow })} />
            </div>
          </FramePanel>
        </Frame>
        <p className="px-1 text-xs text-muted-foreground">
          Skills, @file references and built-in commands work here.
          {draft.holi !== undefined &&
            ' Its Holi adds its soul, its memory and its own rules to every run.'}
        </p>
      </section>

      <Frame spacing="sm">
        <FramePanel flush className="flex flex-col">
          <Button
            variant="ghost"
            className="h-auto w-full justify-between text-start font-normal"
            aria-expanded={advanced}
            onClick={() => setAdvanced((v) => !v)}
          >
            <span className="flex flex-col gap-0.5 py-1">
              <span className="text-sm font-medium text-foreground">Advanced</span>
              <span className="text-xs text-muted-foreground">Catch-up window for missed runs</span>
            </span>
            <ChevronDown
              className={cn(
                'size-3.5 text-muted-foreground',
                cn('motion-respond', advanced && 'rotate-180'),
              )}
            />
          </Button>
          {advanced && (
            <div className="flex items-center justify-between gap-4 border-t border-divider px-(--frame-panel-px) py-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">Missed runs</span>
                <span className="text-xs text-muted-foreground">
                  How late a run this machine slept through may still start
                </span>
              </span>
              <Pill
                label="Catch-up window"
                value={draft.catchUpMinutes === undefined ? 'always' : String(draft.catchUpMinutes)}
                options={CATCH_UP}
                onChange={(v) =>
                  setDraft(({ catchUpMinutes: _old, ...d }) =>
                    v === 'always' ? d : { ...d, catchUpMinutes: Number(v) },
                  )
                }
              />
            </div>
          )}
        </FramePanel>
      </Frame>
    </div>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-automation={summary?.path ?? 'new'}>
      {header}
      {isNew ? (
        <div className="min-h-0 flex-1 overflow-y-auto">{settings}</div>
      ) : (
        <Tabs defaultValue="settings" className="flex min-h-0 flex-1 flex-col">
          <div className="mx-auto w-full max-w-4xl px-8 pt-3">
            <TabsList>
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="history">Run history</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto">
            {settings}
          </TabsContent>
          <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-8 py-5">
              <RunHistory runs={summary.runs} />
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

/** The editor keyed by what it edits, so opening another starts fresh. */
export function useInitialDraft(summary: ScheduleSummary | undefined, holi?: string): Draft {
  return useMemo(
    () => (summary === undefined ? blankDraft(holi) : draftOf(summary)),
    // Re-read when main's view of it moves (a save, a run, a pull).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary === undefined ? `new:${holi ?? ''}` : JSON.stringify(summary)],
  )
}
