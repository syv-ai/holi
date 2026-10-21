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
  cleanLogins,
  editYamlMapping,
  fieldList,
  frontmatterRows,
  frontmatterSchema,
  isFieldSet,
  readYamlMapping,
} from '@holi/shared'
import { useAtomValue } from 'jotai'
import { DateTimePicker, EnumField, FieldRow } from '@/composites'
import { AddFieldRow } from './AddFieldRow'
import { TagsField } from './TagsField'
import { TextField } from './TextField'
import { memberLoginsAtom } from '@/state/members'
import { claimsAtom, frontmatterSuggestionsAtom } from '@/state/plugins'

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
  const claims = useAtomValue(claimsAtom)
  const suggestions = useAtomValue(frontmatterSuggestionsAtom)
  const members = useAtomValue(memberLoginsAtom)

  // A file a plugin claims (a task) is drawn as its claim says.
  const own = claims.find((c) => c.frontmatter !== undefined && c.match(path))?.frontmatter
  const schema = frontmatterSchema(path, own?.fields)
  const values = readYamlMapping(yaml)
  // Nothing to draw as rows; the widget shows the YAML instead (it checks first).
  if (schema === null || values === null) return null

  const write = (patch: Record<string, unknown>): void => onWrite(editYamlMapping(yaml, patch))
  const set = (key: string, next: unknown): void => write({ [key]: next })

  const control = (field: FieldSpec): React.JSX.Element => {
    const Own = own?.controls?.[field.key]
    if (Own !== undefined) return <Own field={field} values={values} write={write} />
    const value = values[field.key]
    switch (field.kind.kind) {
      case 'enum':
        return (
          <EnumField
            name={field.key}
            value={value}
            options={field.kind.options}
            clearable={!field.required}
            onChange={(next) => set(field.key, next)}
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
            onChange={(next) => set(field.key, next ?? undefined)}
          />
        )
      case 'list':
        return (
          <TagsField
            name={field.key}
            value={fieldList(value)}
            suggestions={suggestions.get(field.key) ?? []}
            onChange={(next) => set(field.key, next.length > 0 ? next : undefined)}
          />
        )
      case 'people':
        // GitHub logins, offered from the vault's members and whoever a claim
        // already names, cleaned as the file reader cleans them: `@ada` is
        // ada, and Ada and ada are one.
        return (
          <TagsField
            name={field.key}
            value={fieldList(value)}
            suggestions={cleanLogins([...members, ...(suggestions.get(field.key) ?? [])])}
            onChange={(next) => {
              const logins = cleanLogins(next)
              set(field.key, logins.length > 0 ? logins : undefined)
            }}
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
      {frontmatterRows(schema, Object.keys(values)).map((field) => (
        <FieldRow
          key={field.key}
          label={field.key}
          hover
          // Removing unsets a schema key (its row stays, empty) and deletes any
          // other key with its row. A required key has nothing to remove.
          onRemove={
            !field.required && isFieldSet(values[field.key])
              ? () => set(field.key, undefined)
              : undefined
          }
        >
          {control(field)}
        </FieldRow>
      ))}
      <AddFieldRow existing={Object.keys(values)} schema={schema} onAdd={set} />
    </div>
  )
}
