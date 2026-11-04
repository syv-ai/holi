/**
 * The automation editor's event triggers (`on:`): each a sentence ("When a
 * file is [added] in [inbox/**]").
 */
import { CalendarClock, FileText, ListTodo, Mail, X, type LucideIcon } from 'lucide-react'
import { parseTriggers, triggerYaml, type Trigger } from '@holi/shared'
import { IconButton } from '@/composites/icon-button'
import { Input } from '@/components/ui/input'
import { Pill } from './automation-triggers'

/** The events an automation can start on, for Add trigger, with a first
 *  value each that reads. */
export const EVENTS: { label: string; trigger: Trigger }[] = [
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
export function eventError(t: Trigger): string | undefined {
  const parsed = parseTriggers([triggerYaml(t)])
  return parsed.ok ? undefined : parsed.error.replace(/^on: /, '')
}

/** One `on:` trigger as a sentence: "When a file is [added] in [inbox/**]". */
export function EventRow({
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
