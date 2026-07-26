import { useEffect, useState } from 'react'
import { trpc } from '../lib/trpc'

interface TemplateOption {
  name: string
  slug: string
  description: string
}

/**
 * Convert-to-PDF, slice 1: pick a template, hit Convert. Fields/metadata inputs,
 * the native save dialog, and open-in-Preview are slice 2 — here the render goes
 * to Downloads and is revealed in Finder. Fixed-overlay + stop-propagation card,
 * the house modal pattern (see DeleteConfirm); driven by the caller's useState.
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = path.split('/').at(-1) ?? path

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

  const convert = async () => {
    setBusy(true)
    setError(null)
    try {
      const { pdfPath } = await trpc.pdf.render.mutate({ remote, path, template: slug })
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
