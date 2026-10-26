/**
 * The automation editor's schedule triggers: each a sentence ("Every weekday
 * at [11:00]"), the time zone and the next run.
 */
import { Clock, X } from 'lucide-react'
import {
  CronError,
  cronOfTrigger,
  nextCronTime,
  parseCron,
  type ScheduleTrigger,
} from '@holi/shared'
import { IconButton } from '@/composites/icon-button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const pad = (n: number): string => String(n).padStart(2, '0')

/** Every half hour of the day, as MonoCode offers them. */
const TIMES = Array.from(
  { length: 48 },
  (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`,
)

const MINUTES = [0, 15, 30, 45]

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

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
export function cronFor(t: ScheduleTrigger): { cron: string; error?: string } {
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
export function Pill({
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

export const KINDS: { value: ScheduleTrigger['kind']; label: string }[] = [
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'weekly', label: 'Every week' },
  { value: 'custom', label: 'On a cron' },
]

/** A trigger of another kind, keeping its time where it has one. */
export function retype(t: ScheduleTrigger, kind: ScheduleTrigger['kind']): ScheduleTrigger {
  const time = 'time' in t ? t.time : '09:00'
  if (kind === 'hourly') return { kind, minute: 0 }
  if (kind === 'weekly') return { kind, day: 1, time }
  if (kind === 'custom') return { kind, cron: cronOfTrigger(t) }
  return { kind, time }
}

export function TriggerRow({
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
