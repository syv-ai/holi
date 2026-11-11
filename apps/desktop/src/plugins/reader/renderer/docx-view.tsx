/**
 * A Word document, drawn by docx-preview into an inert frame. The one module
 * that imports docx-preview, loaded lazily so the main chunk never carries it.
 *
 * `patches/docx-preview@0.4.1.patch` fixes two parser bugs until upstream ships
 * them: a style's own paragraph and run properties lost to its base style's (a
 * heading that turns off "page break before" still broke the page;
 * VolodymyrBaydalka/docxjs#259), and content controls around table rows, cells
 * and cell paragraphs dropped (a cover title vanished; docxjs#253). Drop each
 * part of the patch once a release has it.
 *
 * Images come out of the file as `data:` URLs (`useBase64URL`), which the
 * frame's policy allows, and nothing the document links to outside itself is
 * fetched. Pages are paper whatever the theme: a document brings its own
 * colours.
 */
import { useState } from 'react'
import { renderAsync } from 'docx-preview'
import { ErrorState } from '@/composites/empty-state'
import { InertFrame } from './inert-frame-host'

/** The library's grey wrapper gives way to the theme's canvas. */
const DOCX_CSS = `
.docx-wrapper { background: transparent !important; padding: 24px 0 !important; }
.docx-wrapper > section.docx { margin-bottom: 24px !important; }
`

/** Room either side of a page that is scaled to fit. */
const GUTTER = 24

/**
 * Pages wider than the pane are scaled down to fit it, as the PDF viewer
 * opens at fit-width when the page would overflow; never scaled up.
 */
function fitToWidth(body: HTMLElement, pages: HTMLElement): void {
  const page = pages.querySelector<HTMLElement>('section.docx')
  if (page === null) return
  const room = body.clientWidth - 2 * GUTTER
  pages.style.zoom = String(Math.min(1, room / page.offsetWidth))
}

export function DocxView({
  bytes,
  name,
}: {
  bytes: Uint8Array<ArrayBuffer>
  name: string
  path: string
}) {
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  if (error !== null)
    return (
      <ErrorState
        title="This document didn’t open"
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
      css={DOCX_CSS}
      onInternalLink={(href, doc) => {
        // A bookmark or a table of contents entry (`#_Toc…`).
        if (href.startsWith('#'))
          doc.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView()
      }}
      draw={(body) => {
        let live = true
        // Containers of its own: docx-preview empties both before it draws,
        // and the frame's head holds the policy and the canvas styles.
        const doc = body.ownerDocument
        const styles = body.appendChild(doc.createElement('div'))
        const pages = body.appendChild(doc.createElement('div'))
        const fit = () => fitToWidth(body, pages)
        const resize = new ResizeObserver(fit)
        resize.observe(body)
        renderAsync(bytes, pages, styles, {
          inWrapper: true,
          useBase64URL: true,
          // Word's own page breaks from its last save, so pages fall where
          // they did in Word rather than only at explicit breaks.
          ignoreLastRenderedPageBreak: false,
          renderComments: false,
          // An alt chunk is a whole HTML document embedded in the file,
          // drawn as a frame of its own: never.
          renderAltChunks: false,
          experimental: false,
        }).then(fit, (err: unknown) => {
          if (live) setError(err instanceof Error ? err.message : String(err))
        })
        return () => {
          live = false
          resize.disconnect()
        }
      }}
    />
  )
}
