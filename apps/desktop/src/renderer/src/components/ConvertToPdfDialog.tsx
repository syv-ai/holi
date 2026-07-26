import { useEffect, useState } from 'react'
import { trpc } from '../lib/trpc'

interface TemplateField {
  key: string
  label: string
  required: boolean
}

interface TemplateOption {
  name: string
  slug: string
  description: string
  fields: TemplateField[]
}

/**
 * Convert-to-PDF, slice 2: pick a template, fill its declared metadata fields,
 * choose a destination via the native save dialog, Convert. The render writes to
 * the chosen path and is revealed in Finder (open-in-Preview is deliberately not
 * done — the save dialog already told the user where it went). Fixed-overlay +
 * stop-propagation card, the house modal pattern (see DeleteConfirm); driven by
 * the caller's useState.
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

  // Clear field values when the chosen template changes, so one template's
  // inputs never leak into another's meta.
  useEffect(() => {
    setValues({})
  }, [slug])

  const convert = async () => {
    if (selected === null) return
    const missing = selected.fields.filter((f) => f.required && (values[f.key] ?? '').trim() === '')
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
      for (const f of selected.fields) meta[f.key] = (values[f.key] ?? '').trim()
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

        {selected !== null &&
          selected.fields.map((f) => (
            <label key={f.key} className="mb-3 block">
              <span className="mb-1 block text-xs text-neutral-400">
                {f.label}
                {f.required && <span className="text-red-400"> *</span>}
              </span>
              <input
                data-convert-field={f.key}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-100"
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
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
