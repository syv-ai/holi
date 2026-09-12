/**
 * A file's frontmatter as rows you can edit, rather than YAML you must type.
 *
 * The document is still the truth. This reads the YAML between the fences,
 * draws a row per key, and writes the whole body back through
 * `editYamlMapping`, which preserves comments, key order and any nested
 * structure nobody here understands. Nothing is stored in React: a value comes
 * from the document and an edit goes straight back to it.
 *
 * **The schema decides the control, never the contents.** `frontmatterSchema`
 * says a task has a `status` that is one of three words and a `due` that is a
 * moment, so those get a `Select` and the `DateTimePicker`. A key the schema
 * has never heard of is not an error and is never dropped — it gets a text row
 * and is written back verbatim.
 *
 * **Rows are not keys.** Every field the schema names is drawn whether the file
 * has it or not, so a due date can be set without knowing that `due` is the
 * word; nothing reaches the file until a value is actually given.
 */
import {
  type FieldSpec,
  type Recurrence,
  type TaskStatus,
  editYamlMapping,
  frontmatterRows,
  frontmatterSchema,
  isTaskFilePath,
  readYamlMapping,
} from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { X } from 'lucide-react'
import { useState } from 'react'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/primitives'
import { DateTimePicker } from './DateTimePicker'
import { FIELD_CONTROL, FIELD_READONLY, FieldRow } from './FieldRow'
import { RecurrenceField } from './RecurrenceField'
import { duePresets, reminderPresets } from '@/lib/date-presets'
import { cn } from '@/lib/cn'
import { completeTaskAtom, nowAtom } from '@/state/tasks'

/** The sentinel for "not set" in a Radix Select, which forbids an empty value. */
const UNSET = '—'

/** A list value as chips, with a field to add to it. The one control here that
 *  no primitive covers, because `ChipInput` is a mail-address field. */
function TagsField({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    const next = draft
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '' && !value.includes(t))
    setDraft('')
    if (next.length > 0) onChange([...value, ...next])
  }
  return (
    <div
      className={cn(
        FIELD_CONTROL,
        // `h-auto min-h-8` rather than a fixed height: this is the one control
        // whose content grows, and six tags must wrap inside its box rather
        // than out of it.
        'flex h-auto min-h-8 flex-wrap items-center justify-end gap-1 px-2 py-1',
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full border border-input px-2 py-px text-[10px]"
        >
          {tag}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`remove ${tag}`}
            className="size-3 rounded-full p-0 opacity-60 hover:opacity-100"
            onClick={() => onChange(value.filter((t) => t !== tag))}
          >
            <X />
          </Button>
        </span>
      ))}
      <Input
        value={draft}
        aria-label="add a tag"
        placeholder={value.length === 0 ? 'none' : '+'}
        // `dark:bg-transparent` as well as the bare one: the Input primitive
        // carries `dark:bg-input/30`, which is a variant and so outranks an
        // unprefixed override — the empty field read as a filled chip.
        className="h-5 w-16 border-transparent bg-transparent px-1 text-xs shadow-none focus-visible:border-ring dark:bg-transparent"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            onChange(value.slice(0, -1))
          }
        }}
      />
    </div>
  )
}

/** A value the schema does not type, edited as the text it is. Numbers and
 *  booleans are written back as themselves so a `1` does not become `'1'`. */
function TextField({
  value,
  label,
  onChange,
}: {
  value: unknown
  label: string
  onChange: (next: unknown) => void
}): React.JSX.Element {
  const shown = value === undefined || value === null ? '' : String(value)
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (text: string): void => {
    setDraft(null)
    if (text === shown) return
    if (text.trim() === '') return onChange(undefined)
    if (typeof value === 'number' && Number.isFinite(Number(text))) return onChange(Number(text))
    onChange(text)
  }
  return (
    <Input
      value={draft ?? shown}
      aria-label={label}
      placeholder="none"
      className={cn(FIELD_CONTROL, 'text-right')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.currentTarget.blur()
      }}
    />
  )
}

/** A list of strings, read leniently: a hand-written `tags: ops` is one tag. */
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return typeof value === 'string' && value.trim() !== '' ? [value] : []
}

function asRecurrence(value: unknown): Recurrence | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Partial<Recurrence>
  if (typeof raw.frequency !== 'string') return undefined
  return { frequency: raw.frequency, interval: raw.interval ?? 1, ...raw }
}

export function FrontmatterFields({
  path,
  yaml,
  onWrite,
}: {
  /** The file, which is what decides the schema. */
  path: string
  /** The YAML between the fences, exactly as the document has it. */
  yaml: string
  /** The whole YAML body to write back. */
  onWrite: (yaml: string) => void
}): React.JSX.Element | null {
  const now = useAtomValue(nowAtom)
  const complete = useSetAtom(completeTaskAtom)

  const schema = frontmatterSchema(path)
  const values = readYamlMapping(yaml)
  // Both are the same signal: there is nothing here to draw as rows, and the
  // widget shows the YAML instead. It asks first, so this is belt and braces.
  if (schema === null || values === null) return null

  const set = (key: string, next: unknown): void => {
    onWrite(editYamlMapping(yaml, { [key]: next }))
  }

  const isTask = isTaskFilePath(path)
  // **`lastIndexOf` returns -1 for a file at the vault root**, and `slice(0, -1)`
  // is then the path minus its last character — so a root-level task showed a
  // row labelled `folder` whose value was its own filename, one letter short.
  const slash = path.lastIndexOf('/')
  const folder = slash === -1 ? '' : path.slice(0, slash)
  const due = typeof values.due === 'string' ? values.due : undefined

  const control = (field: FieldSpec): React.JSX.Element => {
    const value = values[field.key]
    switch (field.kind.kind) {
      case 'enum': {
        const options = field.kind.options
        return (
          <Select
            value={typeof value === 'string' && options.includes(value) ? value : UNSET}
            onValueChange={(v) => {
              if (v === UNSET) return set(field.key, undefined)
              // The one thing a field edit cannot do by writing text. `done` on
              // a recurring task is not a status, it is a roll-forward to the
              // next occurrence — a bare write would end the series wherever
              // somebody happened to set it (prd/tasks.md §Recurrence).
              if (field.key === 'status' && v === 'done' && isTask) return void complete(path)
              set(field.key, v as TaskStatus)
            }}
          >
            {/* The row's label is a span, not a `<label>`: wrapping a popover
                trigger in one forwards every click inside it, including a tag
                chip's remove button. So the control names itself. */}
            <SelectTrigger
              size="sm"
              aria-label={field.key}
              className={cn(FIELD_CONTROL, 'justify-end gap-2')}
              data-fm-field={field.key}
            >
              <SelectValue placeholder={UNSET} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>{UNSET}</SelectItem>
              {options.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }
      case 'stamp':
      case 'date':
        return (
          <DateTimePicker
            value={typeof value === 'string' ? value : null}
            placeholder={field.key}
            emptyText="none"
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
            value={asList(value)}
            onChange={(next) => set(field.key, next.length > 0 ? next : undefined)}
          />
        )
      case 'recurrence':
        return (
          <RecurrenceField
            value={asRecurrence(value)}
            warnNoDue={isTask && due === undefined}
            data-testid="fm-recurrence"
            onChange={(next) => set(field.key, next)}
          />
        )
      case 'text':
        return (
          <TextField value={value} label={field.key} onChange={(next) => set(field.key, next)} />
        )
    }
  }

  return (
    <div
      // A panel, lightly. The rows are a header band over the document rather
      // than part of its prose, and without an edge they read as a stack of
      // loose controls floating above the first line.
      className="flex flex-col rounded-md border border-divider bg-muted/30 px-1 py-1.5"
      data-frontmatter-fields={path}
    >
      {/* Derived, never written: the folder a file sits in is a fact about the
          vault, and for a task it is also its lane. Editing it would be a move,
          which has to rewrite inbound links and so belongs to the file tree. */}
      {folder !== '' && (
        <FieldRow label="folder" title={path}>
          <span className={FIELD_READONLY}>{folder}</span>
        </FieldRow>
      )}
      {frontmatterRows(schema, Object.keys(values)).map((field) => (
        <FieldRow key={field.key} label={field.key}>
          {control(field)}
        </FieldRow>
      ))}
    </div>
  )
}
