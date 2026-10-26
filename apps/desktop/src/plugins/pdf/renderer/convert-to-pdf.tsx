import type { TemplateField } from '../shared/template-fields'
import { useSetAtom } from 'jotai'
import { useEffect, useId, useMemo, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { openNoteTabAtom } from '@/plugin-api'
import { pdfCap, readNoteText } from './pdf-cap'
import { FieldWidget } from './field-widget'
import {
  metaFromValues,
  missingRequired,
  parseFrontmatter,
  prefillValues,
} from '../shared/pdf-fields'
import { Button } from '@/components/ui/button'
import { DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * A labelled control. Vertical (the caption above) unless `horizontal`, a
 * checkbox's row with its caption beside the control; the label points at the
 * control by id, so pressing the caption reaches it.
 */
function LabelledField({
  label,
  horizontal = false,
  required = false,
  error,
  children,
}: {
  label: string
  horizontal?: boolean
  required?: boolean
  error?: string
  children: (id: string) => React.ReactNode
}): React.JSX.Element {
  const id = useId()
  const caption = (
    <FieldLabel htmlFor={id}>
      {label}
      {required && <span className="text-destructive"> *</span>}
    </FieldLabel>
  )
  return (
    <Field orientation={horizontal ? 'horizontal' : 'vertical'}>
      {caption}
      {children(id)}
      {error !== undefined && <FieldError>{error}</FieldError>}
    </Field>
  )
}

interface TemplateOption {
  name: string
  slug: string
  description: string
  fields: TemplateField[]
  /** What parseFields had to degrade in this template's manifest. */
  warnings: string[]
}

/**
 * Convert-to-PDF: pick a template, fill its typed metadata fields (each the
 * widget its declared type maps to), choose a destination via the native save
 * dialog (which opens beside the note), Convert. A PDF in the vault opens in a
 * tab; one saved elsewhere is revealed in Finder. When the render could not
 * bring everything out (an image, a diagram), the dialog stays to say what,
 * with Done. Fills a Dialog's slots and knows nothing about overlays or sizing.
 */
export function ConvertToPdf({
  remote,
  path,
  onClose,
}: {
  remote: string
  path: string
  onClose: () => void
}): React.JSX.Element {
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null)
  const [slug, setSlug] = useState<string>('')
  const [values, setValues] = useState<Record<string, string>>({})
  /** The note's YAML frontmatter, read once on open; pre-fills matching fields.
   *  `{}` until read, and on any read/parse failure — Convert must never break. */
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Required fields left empty at the last Convert, marked at the field. */
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())
  /** What the finished render reported it could not bring out as written. */
  const [renderWarnings, setRenderWarnings] = useState<string[] | null>(null)
  const name = path.split('/').at(-1) ?? path
  const selected = templates?.find((t) => t.slug === slug) ?? null

  const today = useMemo(() => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }, [])

  useEffect(() => {
    let live = true
    void pdfCap
      .templates(remote)
      .then((list) => {
        if (!live) return
        setTemplates(list)
        setSlug(list[0]?.slug ?? '')
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [remote])

  // Read the note once on open so its frontmatter can pre-fill matching fields.
  useEffect(() => {
    let live = true
    void readNoteText(remote, path)
      .then((text) => live && setFrontmatter(parseFrontmatter(text)))
      .catch(() => live && setFrontmatter({}))
    return () => {
      live = false
    }
  }, [remote, path])

  // Seed each field whenever the chosen template (or the note's frontmatter)
  // changes: the note's declared keys pre-fill their fields, everything else
  // lands on its type default, and one template's values never leak to another.
  useEffect(() => {
    const tpl = templates?.find((t) => t.slug === slug) ?? null
    if (tpl === null) {
      setValues({})
      return
    }
    setValues(prefillValues(tpl.fields, frontmatter, today))
  }, [slug, templates, today, frontmatter])

  const openTab = useSetAtom(openNoteTabAtom)

  const convert = async () => {
    if (selected === null) return
    const empty = missingRequired(selected.fields, values)
    setMissing(new Set(empty.map((f) => f.key)))
    if (empty.length > 0) {
      setError(null)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const outPath = await window.holi.showSaveDialog({
        remote,
        path,
        extension: 'pdf',
        filterName: 'PDF',
      })
      if (outPath === null) {
        setBusy(false)
        return // user cancelled the save dialog
      }
      const meta = metaFromValues(selected.fields, values)
      const { pdfPath, vaultPath, warnings } = await pdfCap.render(remote, {
        path,
        template: slug,
        out: outPath,
        meta,
      })
      // In the vault it opens in a tab, where it can be read and commented
      // on; anywhere else, Finder shows where it went.
      if (vaultPath !== null) openTab(vaultPath)
      else await window.holi.openPath(pdfPath)
      if (warnings.length > 0) {
        setRenderWarnings(warnings)
        setBusy(false)
        return
      }
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (renderWarnings !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            Converted <span className="font-mono text-foreground">{name}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4">
          <div
            role="status"
            data-convert-warnings
            className="flex gap-2 rounded-md bg-muted px-2.5 py-2 text-xs text-foreground"
          >
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-medium">
                The PDF is made, but not everything came out as written:
              </p>
              <ul className="flex list-disc flex-col gap-0.5 pl-4 break-words">
                {renderWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" data-convert-done onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Convert <span className="font-mono text-foreground">{name}</span> to PDF
        </DialogTitle>
      </DialogHeader>

      <div className="flex min-w-0 flex-col gap-4">
        {templates === null && error === null && (
          <div role="status" aria-label="Loading templates" className="flex flex-col gap-1">
            <span className="block h-3.5 w-16 rounded-md motion-shimmer" />
            <span className="block h-9 w-full rounded-md motion-shimmer" />
          </div>
        )}
        {templates !== null && templates.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No templates in this vault. Expected a seeded <span className="font-mono">Plain</span>{' '}
            under <span className="font-mono">.holi/document-templates/</span>.
          </p>
        )}
        {templates !== null && templates.length > 0 && (
          <LabelledField label="Template">
            {(id) => (
              <Select value={slug} onValueChange={setSlug}>
                <SelectTrigger id={id} className="w-full" data-convert-template>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.slug} value={t.slug}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </LabelledField>
        )}

        {selected !== null && selected.warnings.length > 0 && (
          <div className="flex gap-2 rounded-md bg-muted px-2.5 py-2 text-xs text-foreground">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-medium">
                This template&rsquo;s manifest had problems, so Holi used safe defaults:
              </p>
              <ul className="flex list-disc flex-col gap-0.5 pl-4 break-words">
                {selected.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {selected !== null &&
          selected.fields.map((f) => {
            const invalid = missing.has(f.key)
            const widget = (id?: string) => (
              <FieldWidget
                field={f}
                id={id}
                invalid={invalid}
                value={values[f.key] ?? ''}
                onChange={(v) => {
                  setValues((prev) => ({ ...prev, [f.key]: v }))
                  if (invalid) {
                    setMissing((prev) => {
                      const next = new Set(prev)
                      next.delete(f.key)
                      return next
                    })
                  }
                }}
              />
            )
            // A checkbox reads as one row, its label beside the box; every
            // other control takes its caption above.
            return f.type === 'checkbox' ? (
              <LabelledField key={f.key} label={f.label} horizontal>
                {(id) => widget(id)}
              </LabelledField>
            ) : (
              <LabelledField
                key={f.key}
                label={f.label}
                required={f.required}
                error={invalid ? `${f.label} is required.` : undefined}
              >
                {(id) => widget(id)}
              </LabelledField>
            )
          })}

        {error !== null && (
          <p role="alert" className="text-xs text-pretty break-words text-destructive">
            {error}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          data-convert-confirm
          disabled={busy || slug === ''}
          onClick={() => void convert()}
        >
          {busy ? 'Converting…' : 'Convert'}
        </Button>
      </DialogFooter>
    </>
  )
}
