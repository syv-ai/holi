import { type TemplateField, initialValue } from '@holi/shared'
import { useEffect, useMemo, useState } from 'react'
import { trpc } from '../lib/trpc'
import { FieldWidget } from './pdf/FieldWidget'

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
 * Convert. The render writes to the chosen path and is revealed in Finder. The
 * house modal pattern (fixed overlay + stop-propagation card), driven by the
 * caller's useState.
 */
export function ConvertToPdfDialog({
  remote,
  path,
  onClose,
}: {
  remote: string
  path: string
  onClose: () => void
}) {
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
    const missing = selected.fields.filter(
      (f) => f.required && f.type !== 'checkbox' && (values[f.key] ?? '').trim() === '',
    )
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
      const meta: Record<string, string> = {}
      for (const f of selected.fields) meta[f.key] = values[f.key] ?? ''
      const { pdfPath } = await trpc.pdf.render.mutate({ remote, path, template: slug, outPath, meta })
      await window.holi.openPath(pdfPath)
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        data-convert-dialog={path}
        className="w-96 rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-200 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-3">
          Convert <span className="font-mono text-neutral-100">{name}</span> to PDF
        </p>

        {templates === null && error === null && (
          <p className="mb-3 text-xs text-neutral-500">Loading templates…</p>
        )}
        {templates !== null && templates.length === 0 && (
          <p className="mb-3 text-xs text-neutral-500">
            No templates in this vault. Expected a seeded <span className="font-mono">Plain</span>{' '}
            under <span className="font-mono">.holi/templates/</span>.
          </p>
        )}
        {templates !== null && templates.length > 0 && (
          <label className="mb-3 block">
            <span className="mb-1 block text-xs text-neutral-400">Template</span>
            <select
              data-convert-template
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-100"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            >
              {templates.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {selected !== null && selected.warnings.length > 0 && (
          <div className="mb-3 rounded border border-amber-900/60 bg-amber-950/40 px-2.5 py-2 text-xs text-amber-100">
            <p className="mb-1 font-medium">This template's manifest had issues (using safe defaults):</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {selected.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {selected !== null &&
          selected.fields.map((f) => (
            <label key={f.key} className="mb-3 flex flex-col gap-1">
              <span className="text-xs text-neutral-400">
                {f.label}
                {f.required && f.type !== 'checkbox' && <span className="text-red-400"> *</span>}
              </span>
              <FieldWidget
                field={f}
                value={values[f.key] ?? ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
              />
            </label>
          ))}

        {error !== null && <p className="mb-3 text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            data-convert-confirm
            disabled={busy || slug === ''}
            className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-900 hover:bg-white disabled:opacity-40"
            onClick={() => void convert()}
          >
            {busy ? 'Converting…' : 'Convert'}
          </button>
        </div>
      </div>
    </div>
  )
}
