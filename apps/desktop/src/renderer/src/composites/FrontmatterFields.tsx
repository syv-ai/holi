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
import { Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'
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
import { FileFactsLine } from './FileFactsLine'
import { FIELD_CONTROL, FIELD_UNSET, FieldRow } from './FieldRow'
import { RecurrenceField } from './RecurrenceField'
import { duePresets, reminderPresets } from '@/lib/date-presets'
import { cn } from '@/lib/cn'
import { completeTaskAtom, nowAtom } from '@/state/tasks'

/** The VALUE that means "unset" in a Radix Select, which forbids ''. A real
 *  option so a set field can be cleared; an unset field shows nothing. */
const UNSET = '—'

/** What an unset field READS as: nothing. */
const UNSET_LABEL = ''

/**
 * A list value as chips with somewhere to type more, as ONE control: the bare
 * input takes the width the chips leave, and a press in the gaps focuses it.
 *
 * Not `ChipInput`: that is a mail-address field with validation and
 * suggestions, and a tag is any short string.
 */
function TagsField({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)
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
        // `h-auto min-h-8`: tags must wrap inside the box.
        'flex h-auto min-h-8 cursor-text flex-wrap items-center justify-end gap-1 py-1',
        'motion-respond focus-within:bg-muted/40',
      )}
      onMouseDown={(e) => {
        // Only the box itself: a chip's remove button handles its own press.
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        input.current?.focus()
      }}
    >
      <Input
        ref={input}
        variant="bare"
        value={draft}
        aria-label="add a tag"
        placeholder=""
        // `flex-1`: the input owns every pixel the chips do not. Before the
        // chips so they stay at the right edge, where other values end.
        className="w-auto min-w-8 flex-1 text-right text-xs"
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
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-px text-[10px]"
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
      placeholder=""
      // `dark:bg-transparent`: the Input primitive's `dark:bg-input/30` variant
      // outranks FIELD_CONTROL's bare `bg-transparent`. Focus takes the
      // Button's focus ring.
      className={cn(
        FIELD_CONTROL,
        'text-right dark:bg-transparent focus-visible:ring-1 focus-visible:ring-ring',
      )}
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

/**
 * A key this block may add: one plain YAML word (no colon, no leading `#`,
 * `-`, `?` or quote, no newline), not already present. Schema keys are refused
 * too, including hidden ones (`order`), which would otherwise be a back door.
 */
export function addableKey(
  raw: string,
  existing: readonly string[],
  schema: readonly FieldSpec[],
): string | null {
  const key = raw.trim()
  if (!/^[^\s:#\-?'"][^:\n]*$/.test(key)) return null
  if (existing.includes(key) || schema.some((f) => f.key === key)) return null
  return key
}

/**
 * The last row: any key, free text. Open, it is two inputs in the same columns
 * as the rows above. Enter moves key to value, then writes; Escape or leaving
 * empty closes. A value is required: a bare key is a `null` in the file.
 */
function AddFieldRow({
  existing,
  schema,
  onAdd,
}: {
  existing: readonly string[]
  schema: readonly FieldSpec[]
  onAdd: (key: string, value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const valueInput = useRef<HTMLInputElement>(null)
  const valid = addableKey(key, existing, schema)
  const bad = key.trim() !== '' && valid === null

  const close = (): void => {
    setOpen(false)
    setKey('')
    setValue('')
  }
  const submit = (): void => {
    if (valid === null || value.trim() === '') return
    onAdd(valid, value.trim())
    close()
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="xs"
        className="motion-respond self-start px-1 font-normal text-muted-foreground hover:bg-muted/40"
        onClick={() => setOpen(true)}
      >
        <Plus />
        add field
      </Button>
    )
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-1 py-0.5"
      data-fm-add-field=""
      onBlur={(e) => {
        // Leaving the row, not moving between its two inputs.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        if (valid !== null && value.trim() !== '') submit()
        else close()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        close()
      }}
    >
      <Input
        variant="bare"
        autoFocus
        value={key}
        aria-label="new field name"
        aria-invalid={bad}
        placeholder="name"
        className={cn('min-w-0 shrink-0 basis-24 text-xs md:text-xs', bad && 'text-destructive')}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          if (valid !== null) valueInput.current?.focus()
        }}
      />
      <Input
        ref={valueInput}
        variant="bare"
        value={value}
        aria-label="new field value"
        placeholder="value"
        className="min-w-32 flex-1 px-3 text-right text-xs md:text-xs"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          submit()
        }}
      />
    </div>
  )
}

/** Whether a key holds anything to remove: the scaffold's `tags: []` does not. */
function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  return !Array.isArray(value) || value.length > 0
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
  const complete = useSetAtom(completeTaskAtom)

  const schema = frontmatterSchema(path)
  const values = readYamlMapping(yaml)
  // Nothing to draw as rows; the widget shows the YAML instead (it checks first).
  if (schema === null || values === null) return null

  const set = (key: string, next: unknown): void => {
    onWrite(editYamlMapping(yaml, { [key]: next }))
  }

  const isTask = isTaskFilePath(path)
  const due = typeof values.due === 'string' ? values.due : undefined

  const control = (field: FieldSpec): React.JSX.Element => {
    const value = values[field.key]
    switch (field.kind.kind) {
      case 'enum': {
        const options = field.kind.options
        const chosen = typeof value === 'string' && options.includes(value) ? value : UNSET
        return (
          // Undefined, not the sentinel, when unset: Radix renders the selected
          // item's text, so `UNSET` would print its `—`.
          <Select
            value={chosen === UNSET ? undefined : chosen}
            onValueChange={(v) => {
              if (v === UNSET) return set(field.key, undefined)
              // `done` on a recurring task is a roll-forward to the next
              // occurrence, not a status write, which would end the series
              // (docs/features/tasks.md).
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
              className={cn(FIELD_CONTROL, 'justify-end gap-2', chosen === UNSET && FIELD_UNSET)}
              data-fm-field={field.key}
            >
              <SelectValue placeholder={UNSET_LABEL} />
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
          onRemove={isSet(values[field.key]) ? () => set(field.key, undefined) : null}
        >
          {control(field)}
        </FieldRow>
      ))}
      <AddFieldRow existing={Object.keys(values)} schema={schema} onAdd={set} />
    </div>
  )
}
