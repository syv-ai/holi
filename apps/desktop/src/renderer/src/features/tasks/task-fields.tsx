/**
 * A task's own frontmatter controls (`ClaimFrontmatter.controls`): the
 * fields whose edit is more than a value. Done is completion, the dates offer
 * the task presets, and a recurrence is its nested rule.
 */
import { completeTask, fieldRecurrence } from '@holi/shared'
import { useAtomValue } from 'jotai'
import type { FieldControlProps } from '@/plugin-api/types'
import { DateTimePicker, EnumField, RecurrenceField } from '@/composites'
import { duePresets, reminderPresets } from '@/lib/date-presets'
import { nowAtom, todayAtom } from '@/state/clock'

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** Status. Done is completion: on a recurring task, the next occurrence
 *  rather than the end of the series (docs/features/tasks.md). Written into
 *  the buffer, like every other field edit. */
function StatusControl({ field, values, write }: FieldControlProps): React.JSX.Element {
  const today = useAtomValue(todayAtom)
  return (
    <EnumField
      name={field.key}
      value={values[field.key]}
      options={field.kind.kind === 'enum' ? field.kind.options : []}
      clearable={false}
      onChange={(next) =>
        write(
          next === 'done'
            ? {
                ...completeTask(
                  {
                    due: text(values.due),
                    reminder: text(values.reminder),
                    recurrence: fieldRecurrence(values.recurrence),
                  },
                  today,
                ),
              }
            : { [field.key]: next },
        )
      }
    />
  )
}

/** A date with the task presets: due's from now, the reminder's from due. */
function datePicker(presets: 'due' | 'reminder') {
  return function DateControl({ field, values, write }: FieldControlProps): React.JSX.Element {
    const now = useAtomValue(nowAtom)
    return (
      <DateTimePicker
        variant="field"
        value={text(values[field.key]) ?? null}
        placeholder={field.key}
        emptyText=""
        data-testid={`fm-${field.key}`}
        presets={presets === 'due' ? duePresets(now) : reminderPresets(text(values.due), now)}
        onChange={(next) => write({ [field.key]: next ?? undefined })}
      />
    )
  }
}

/** The recurrence rule, which warns while there is no due date to roll. */
function RecurrenceControl({ field, values, write }: FieldControlProps): React.JSX.Element {
  return (
    <RecurrenceField
      variant="field"
      value={fieldRecurrence(values[field.key])}
      warnNoDue={text(values.due) === undefined}
      data-testid="fm-recurrence"
      onChange={(next) => write({ [field.key]: next })}
    />
  )
}

export const TASK_CONTROLS = {
  status: StatusControl,
  due: datePicker('due'),
  reminder: datePicker('reminder'),
  recurrence: RecurrenceControl,
}
