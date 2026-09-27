/**
 * A file's frontmatter as editable rows (docs/features/frontmatter.md).
 *
 * The document is the truth: rows are read from the YAML and every edit writes
 * the whole body back through `editYamlMapping`, which preserves comments, key
 * order and nested structure. Nothing is stored in React.
 *
 * The schema decides the control, never the contents. An unknown key gets a
 * text row and is written back verbatim. Every schema field is drawn whether
 * the file has it or not; nothing reaches the file until a value is given.
 * Each control is its own file in `frontmatter/`; this is the table from
 * field kind to control.
 */
import {
  type FieldSpec,
  completeTask,
  editYamlMapping,
  fieldList,
  fieldRecurrence,
  frontmatterRows,
  frontmatterSchema,
  isFieldSet,
  isTaskFilePath,
  readYamlMapping,
} from '@holi/shared'
import { useAtomValue } from 'jotai'
import { DateTimePicker } from './DateTimePicker'
import { FileFactsLine } from './FileFactsLine'
import { FieldRow } from './FieldRow'
import { RecurrenceField } from './RecurrenceField'
import { AddFieldRow } from './frontmatter/AddFieldRow'
import { EnumField } from './frontmatter/EnumField'
import { TagsField } from './frontmatter/TagsField'
import { TextField } from './frontmatter/TextField'
import { duePresets, reminderPresets } from '@/lib/date-presets'
import { nowAtom, taskTagsAtom, todayAtom } from '@/state/tasks'

export function FrontmatterFields({
  path,
  yaml,
  onWrite,
  facts = false,
}: {
  /** The file, which is what decides the schema. */
  path: string
  /** The YAML between the fences, exactly as the document has it. */
  yaml: string
  /** The whole YAML body to write back. */
  onWrite: (yaml: string) => void
  /** Draw the read-only facts line over the rows (`FileFactsLine`), which
   *  asks main for the file's history and links. */
  facts?: boolean
}): React.JSX.Element | null {
  const now = useAtomValue(nowAtom)
  const today = useAtomValue(todayAtom)
  const tags = useAtomValue(taskTagsAtom)

  const schema = frontmatterSchema(path)
  const values = readYamlMapping(yaml)
  // Nothing to draw as rows; the widget shows the YAML instead (it checks first).
  if (schema === null || values === null) return null

  const write = (patch: Record<string, unknown>): void => onWrite(editYamlMapping(yaml, patch))
  const set = (key: string, next: unknown): void => write({ [key]: next })

  const isTask = isTaskFilePath(path)
  const due = typeof values.due === 'string' ? values.due : undefined
  const reminder = typeof values.reminder === 'string' ? values.reminder : undefined

  const control = (field: FieldSpec): React.JSX.Element => {
    const value = values[field.key]
    switch (field.kind.kind) {
      case 'enum':
        return (
          <EnumField
            name={field.key}
            value={value}
            options={field.kind.options}
            onChange={(next) =>
              // Done is completion: on a recurring task, the next occurrence
              // rather than the end of the series (docs/features/tasks.md).
              // Written into this buffer, like every other field edit.
              field.key === 'status' && next === 'done' && isTask
                ? write({
                    ...completeTask(
                      { due, reminder, recurrence: fieldRecurrence(values.recurrence) },
                      today,
                    ),
                  })
                : set(field.key, next)
            }
          />
        )
      case 'stamp':
      case 'date':
        return (
          <DateTimePicker
            variant="field"
            value={typeof value === 'string' ? value : null}
            placeholder={field.key}
            emptyText=""
            dateOnly={field.kind.kind === 'date'}
            data-testid={`fm-${field.key}`}
            presets={
              !isTask
                ? undefined
                : field.key === 'due'
                  ? duePresets(now)
                  : field.key === 'reminder'
                    ? reminderPresets(due, now)
                    : undefined
            }
            onChange={(next) => set(field.key, next ?? undefined)}
          />
        )
      case 'list':
        return (
          <TagsField
            name={field.key}
            value={fieldList(value)}
            suggestions={tags}
            onChange={(next) => set(field.key, next.length > 0 ? next : undefined)}
          />
        )
      case 'recurrence':
        return (
          <RecurrenceField
            variant="field"
            value={fieldRecurrence(value)}
            warnNoDue={isTask && due === undefined}
            data-testid="fm-recurrence"
            onChange={(next) => set(field.key, next)}
          />
        )
      case 'text':
        return (
          <TextField name={field.key} value={value} onChange={(next) => set(field.key, next)} />
        )
    }
  }

  return (
    <div
      // Not a panel: the note's own metadata, on the note's own ground.
      className="flex flex-col bg-transparent px-1 py-1.5 text-foreground"
      data-frontmatter-fields={path}
    >
      {facts && <FileFactsLine path={path} />}
      {frontmatterRows(schema, Object.keys(values)).map((field) => (
        <FieldRow
          key={field.key}
          label={field.key}
          hover
          // Removing unsets a schema key (its row stays, empty) and deletes any
          // other key with its row.
          onRemove={isFieldSet(values[field.key]) ? () => set(field.key, undefined) : undefined}
        >
          {control(field)}
        </FieldRow>
      ))}
      <AddFieldRow existing={Object.keys(values)} schema={schema} onAdd={set} />
    </div>
  )
}
