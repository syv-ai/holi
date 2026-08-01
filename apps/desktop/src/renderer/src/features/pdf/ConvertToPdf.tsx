import { type TemplateField, initialValue } from '@holi/shared'
import { useEffect, useMemo, useState } from 'react'
import { FormField } from '@/composites/FormField'
import { FieldWidget } from '@/features/pdf/FieldWidget'
import { trpc } from '@/lib/trpc'
import { metaFromValues, missingRequired } from '@/lib/pdf-fields'
import {
  Button,
  Dialog,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/primitives'

interface TemplateOption {
  name: string
  slug: string
  description: string
  fields: TemplateField[]
  /** What parseFields had to degrade in this template's manifest. */
  warnings: string[]
}

/**
 * Convert-to-PDF: pick a template, fill its typed metadata fields (each rendered
 * as the widget its declared type maps to — a date picker prefilled to today, a
 * dropdown, a checkbox, …), choose a destination via the native save dialog,
 * Convert. The render writes to the chosen path and is revealed in Finder.
 *
 * The pdf-domain content block: it knows nothing about overlays or sizing — it
 * fills a Dialog's Header/Body/Footer slots and the registry summons it at
 * `size: 'md'`. Footer owns its own busy state (the slot, not a shell prop).
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = path.split('/').at(-1) ?? path
  const selected = templates?.find((t) => t.slug === slug) ?? null

  const today = useMemo(() => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }, [])

  useEffect(() => {
    let live = true
    void trpc.pdf.templates
      .query({ remote })
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

  // Seed each field from its type/default whenever the chosen template changes,
  // so a date field lands on today and one template's values never leak to another.
  useEffect(() => {
    const tpl = templates?.find((t) => t.slug === slug) ?? null
    if (tpl === null) {
      setValues({})
      return
    }
    const seed: Record<string, string> = {}
    for (const f of tpl.fields) seed[f.key] = initialValue(f, today)
    setValues(seed)
  }, [slug, templates, today])

  const convert = async () => {
    if (selected === null) return
    const missing = missingRequired(selected.fields, values)
    if (missing.length > 0) {
      setError(
        `Fill required field${missing.length > 1 ? 's' : ''}: ${missing
          .map((f) => f.label)
          .join(', ')}`,
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      const defaultName = name.replace(/\.(md|markdown)$/i, '') + '.pdf'
      const outPath = await window.holi.showSaveDialog(defaultName)
      if (outPath === null) {
        setBusy(false)
        return // user cancelled the save dialog
      }
      const meta = metaFromValues(selected.fields, values)
      const { pdfPath } = await trpc.pdf.render.mutate({ remote, path, template: slug, outPath, meta })
      await window.holi.openPath(pdfPath)
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog.Header>
        Convert <span className="font-mono text-foreground">{name}</span> to PDF
      </Dialog.Header>

      <Dialog.Body>
        {templates === null && error === null && (
          <p className="text-xs text-muted-foreground">Loading templates…</p>
        )}
        {templates !== null && templates.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No templates in this vault. Expected a seeded <span className="font-mono">Plain</span>{' '}
            under <span className="font-mono">.holi/templates/</span>.
          </p>
        )}
        {templates !== null && templates.length > 0 && (
          <FormField label="Template">
            <Select value={slug} onValueChange={setSlug}>
              <SelectTrigger className="w-full" data-convert-template>
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
          </FormField>
        )}

        {selected !== null && selected.warnings.length > 0 && (
          <div className="rounded border border-amber-900/60 bg-amber-950/40 px-2.5 py-2 text-xs text-amber-100">
            <p className="mb-1 font-medium">
              This template's manifest had issues (using safe defaults):
            </p>
            <ul className="list-disc space-y-0.5 pl-4">
              {selected.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {selected !== null &&
          selected.fields.map((f) => (
            <FormField
              key={f.key}
              label={f.label}
              required={f.required && f.type !== 'checkbox'}
            >
              <FieldWidget
                field={f}
                value={values[f.key] ?? ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
              />
            </FormField>
          ))}

        {error !== null && <p className="text-xs text-destructive">{error}</p>}
      </Dialog.Body>

      <Dialog.Footer>
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
      </Dialog.Footer>
    </>
  )
}
