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
 *
 * The frame owns its drawing's lifecycle: a page's shape until the file is
 * drawn, the error with Retry if it never is, and a fresh frame on Retry.
 */
import { useAtomValue } from 'jotai'
import { useLayoutEffect, useRef, useState } from 'react'
import { ErrorState } from '@/composites/empty-state'
import { activeModeAtom } from '@/plugin-api'
import { followLink, forwardShortcuts, inertFrameDocument } from './inert-frame'
import { ReaderLoading } from './reader-pane'

/** A theme token's colour as the app's document resolves it now, for a frame,
 *  which cannot read the app's CSS variables. The vault's theme is included. */
export function themeColour(
  token: '--muted' | '--background' | '--foreground' | '--primary',
): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim()
}

const canvasColour = () => themeColour('--muted') || 'gray'

interface FrameProps {
  /** Names the frame for a screen reader: the file's name. */
  label: string
  /** The viewer's own stylesheet, put in after the canvas. */
  css?: string
  /** Builds the file into the frame's body and settles once it is drawn.
   *  `signal` aborts when the frame goes: undo what was built on it. Called
   *  once per frame, so a new file version is a new `key` on this component. */
  draw: (body: HTMLElement, signal: AbortSignal) => Promise<void>
  /** A link within the file (`#bookmark`); none by default. */
  onInternalLink?: (href: string, doc: Document) => void
}

export function InertFrame({
  failure,
  ...frame
}: FrameProps & {
  /** The error's title when the file cannot be drawn. */
  failure: string
}) {
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  if (error !== null)
    return (
      <ErrorState
        title={failure}
        message={error}
        onRetry={() => {
          setError(null)
          setAttempt((n) => n + 1)
        }}
      />
    )
  return <Frame key={attempt} {...frame} onError={setError} />
}

function Frame({
  label,
  css,
  draw,
  onInternalLink,
  onError,
}: FrameProps & { onError: (message: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const mode = useAtomValue(activeModeAtom)
  const [drawn, setDrawn] = useState(false)
  // The first render's only: `draw` and `css` belong to this frame (see `draw`).
  const drawRef = useRef(draw)
  const cssRef = useRef(css)
  const internalRef = useRef(onInternalLink)
  const errorRef = useRef(onError)

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

    const abort = new AbortController()
    drawRef.current(doc.body, abort.signal).then(
      () => {
        if (!abort.signal.aborted) setDrawn(true)
      },
      (err: unknown) => {
        if (!abort.signal.aborted)
          errorRef.current(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      abort.abort()
      doc.removeEventListener('click', onCapturedClick, true)
      unforward()
    }
  }, [])

  useLayoutEffect(() => {
    const root = ref.current?.contentDocument?.documentElement
    if (root == null) return
    const colour = canvasColour()
    root.style.background = colour
    root.ownerDocument.body.style.background = colour
  }, [mode])

  // The frame keeps its size while it is drawn, under the page's shape: the
  // renderers fit what they draw to its width.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <iframe
        ref={ref}
        sandbox="allow-same-origin"
        aria-label={label}
        className={`block min-h-0 w-full flex-1 border-0 ${drawn ? '' : 'invisible'}`}
      />
      {!drawn && (
        <div className="absolute inset-0 flex flex-col">
          <ReaderLoading />
        </div>
      )}
    </div>
  )
}
