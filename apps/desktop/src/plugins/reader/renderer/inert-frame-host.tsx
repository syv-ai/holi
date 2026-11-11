/**
 * The frame a docx or pptx is drawn into. `sandbox="allow-same-origin"` and
 * nothing else: the app's script can build into its document, and nothing in
 * it can run (granting `allow-scripts` as well would let the content drop its
 * own sandbox). Written into rather than given a `srcdoc`, so the document is
 * there on the same tick, as the Google plugin's mail frame does.
 *
 * The pages sit on the theme's muted canvas. A frame cannot read the app's CSS
 * variables, so the colour is resolved here and set again when the mode flips,
 * without rebuilding what was drawn.
 */
import { useAtomValue } from 'jotai'
import { useLayoutEffect, useRef } from 'react'
import { activeModeAtom } from '@/plugin-api'
import { followLink, forwardShortcuts, inertFrameDocument } from './inert-frame'

/** A theme token's colour as the app's document resolves it now, for a frame,
 *  which cannot read the app's CSS variables. The vault's theme is included. */
export function themeColour(
  token: '--muted' | '--background' | '--foreground' | '--primary',
): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim()
}

const canvasColour = () => themeColour('--muted') || 'gray'

export function InertFrame({
  label,
  css,
  draw,
  onInternalLink,
}: {
  /** Names the frame for a screen reader: the file's name. */
  label: string
  /** The viewer's own stylesheet, put in after the canvas. */
  css?: string
  /** Builds the file into the frame's body; returns its cleanup. Called once
   *  per mount, so a new file version is a new `key` on this component. */
  draw: (body: HTMLElement) => () => void
  /** A link within the file (`#bookmark`); none by default. */
  onInternalLink?: (href: string, doc: Document) => void
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const mode = useAtomValue(activeModeAtom)
  // The first draw only: `draw` and `css` belong to this mount (see `draw`).
  const drawRef = useRef(draw)
  const cssRef = useRef(css)
  const internalRef = useRef(onInternalLink)

  useLayoutEffect(() => {
    const frame = ref.current
    const doc = frame?.contentDocument
    if (frame == null || doc == null) return
    doc.open()
    doc.write(inertFrameDocument({ css: cssRef.current, background: canvasColour() }))
    doc.close()

    // Capture, and stopped: a renderer's own link handler (pptx's calls
    // `window.open`) never sees the click.
    const onCapturedClick = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.('a, area') == null) return
      event.stopPropagation()
      followLink(event, (href) => internalRef.current?.(href, doc))
    }
    doc.addEventListener('click', onCapturedClick, true)

    const unforward = forwardShortcuts(doc, frame)

    const undraw = drawRef.current(doc.body)
    return () => {
      doc.removeEventListener('click', onCapturedClick, true)
      unforward()
      undraw()
    }
  }, [])

  useLayoutEffect(() => {
    const root = ref.current?.contentDocument?.documentElement
    if (root == null) return
    const colour = canvasColour()
    root.style.background = colour
    root.ownerDocument.body.style.background = colour
  }, [mode])

  return (
    <iframe
      ref={ref}
      sandbox="allow-same-origin"
      aria-label={label}
      className="block min-h-0 w-full flex-1 border-0"
    />
  )
}
