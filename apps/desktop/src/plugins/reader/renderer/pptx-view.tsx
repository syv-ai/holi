/**
 * A PowerPoint deck, drawn by `@aiden0z/pptx-renderer` into an inert frame,
 * every slide one under another. The one module that imports the renderer
 * (and echarts, for a deck's charts), loaded lazily so the main chunk never
 * carries them.
 *
 * - **Nothing outside the file.** `externalMedia: 'block'` skips every linked
 *   image, fill, audio and video; `pdfjs: false` drops the PDF fallback for EMF
 *   previews; the zip limits bound what a hostile archive can make it unpack.
 * - **Charts draw as SVG.** A `<canvas>` in a document with scripting disabled
 *   shows only its fallback content, so echarts' default canvas charts stay
 *   blank in the inert frame. `patches/@aiden0z__pptx-renderer@1.4.0.patch`
 *   makes the renderer use echarts' SVG renderer; once the `chartRenderer`
 *   option (aiden0z/pptx-renderer#56) is released, pass `chartRenderer: 'svg'`
 *   here and drop the patch.
 * - **Text boxes** take the presentation's default text size, not the master's
 *   `otherStyle`, which is for tables (aiden0z/pptx-renderer#57; checked
 *   against Apple's Quick Look and LibreOffice). The same patch carries it.
 * - **Picture placeholders** take their layout placeholder's shape (an arch, a
 *   circle) when they set none of their own (aiden0z/pptx-renderer#58); also in
 *   the patch.
 * - **Links** are taken by the frame (`InertFrame`) before the renderer's own
 *   handler, which would call `window.open`.
 * - **Large decks** parse their slides and media only as they are drawn.
 * - A deck's embedded fonts register on the app's document, not the frame's,
 *   so its slides fall back to the system's fonts (docs/features/reader.md).
 */
import { useState } from 'react'
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer'
import { ErrorState } from '@/composites/empty-state'
import { InertFrame } from './inert-frame-host'

/** Room around the slides, so they sit on the canvas rather than at its edge. */
const PPTX_CSS = 'body { padding: 24px; box-sizing: border-box; }'

export function PptxView({ bytes, name }: { bytes: Uint8Array<ArrayBuffer>; name: string }) {
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  if (error !== null)
    return (
      <ErrorState
        title="This deck didn’t open"
        message={error}
        onRetry={() => {
          setError(null)
          setAttempt((n) => n + 1)
        }}
      />
    )
  return (
    <InertFrame
      key={attempt}
      label={name}
      css={PPTX_CSS}
      draw={(body) => {
        const abort = new AbortController()
        // A container of its own: the renderer fits slides to its
        // `clientWidth`, which on the body would count the padding.
        const slides = body.appendChild(body.ownerDocument.createElement('div'))
        const opened = PptxViewer.open(bytes.buffer, slides, {
          renderMode: 'list',
          fitMode: 'contain',
          externalMedia: 'block',
          pdfjs: false,
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          lazyMedia: true,
          lazySlides: true,
          signal: abort.signal,
        })
        opened.catch((err: unknown) => {
          if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err))
        })
        return () => {
          abort.abort()
          void opened.then((viewer) => viewer.destroy()).catch(() => {})
        }
      }}
    />
  )
}
