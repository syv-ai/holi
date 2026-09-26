/**
 * Third-party HTML, rendered in a page of its own.
 *
 * Google hands Holi markup a stranger wrote in two places, a mail body and a
 * **calendar event description**, so both go down this one path.
 * [[mail-html]] decides what markup survives, [[mail-frame]] decides what
 * document it survives *in*, and neither substitutes for the other. Sanitized
 * markup never lands in the app's document.
 *
 * Remote content is blocked until asked for, per block of HTML: an image fetched
 * from a sender's server is a read receipt nobody agreed to.
 *
 * The `mail-` modules are not mail-specific and are deliberately not renamed,
 * so the security-relevant code and its test suites stay put.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { Button } from '@/primitives'
import {
  canvasFor,
  mailFrameDocument,
  openableLink,
  useMailPalette,
  type MailPalette,
} from '../../lib/mail-frame'
import { sanitizeMailHtml } from '../../lib/mail-html'
import { useRemoteContent, type RemoteContentIdentity } from '../../state/mail-images'
import { registerMailFrame } from '../../state/mail-frames'
import { matchHotkey } from '../../lib/hotkey'

interface SandboxedHtmlProps {
  /** Raw and untrusted. Sanitizing happens **here**; a caller must not pre-sanitize. */
  html: string
  /** Names the frame for a screen reader, e.g. `message from Jane`. */
  label: string
  /**
   * Who this block belongs to, so an unblock can be remembered. Optional: a
   * calendar event description has no identity worth keeping, and without one
   * the choice lives and dies with this component.
   */
  identity?: RemoteContentIdentity
}

const NO_IDENTITY: RemoteContentIdentity = { key: null, sender: null }

/**
 * One block of untrusted HTML: a sandboxed frame, with images held back.
 *
 * Unblocking re-sanitizes from the *original* HTML rather than restoring
 * stripped URLs, so whatever renders has been through the sanitizer under the
 * current setting.
 *
 * **The unblock is remembered outside this component** ([[state/mail-images]])
 * because the reader unmounts every time a thread closes. Local state is only
 * the fallback for a block with no identity.
 */
export function SandboxedHtml({
  html,
  label,
  identity = NO_IDENTITY,
}: SandboxedHtmlProps): React.JSX.Element {
  const remote = useRemoteContent(identity)
  /** The unblock for a block with nothing to remember it by. */
  const [allowedLocally, setAllowedLocally] = useState(false)
  const allowRemoteContent = remote.allowed || allowedLocally

  const themed = useMailPalette()
  const sanitized = useMemo(
    () => sanitizeMailHtml(html, { allowRemoteContent }),
    [html, allowRemoteContent],
  )
  // From the RAW html, so loading images cannot flip the canvas underneath the
  // message. See `bringsOwnDesign`.
  const palette = useMemo(() => canvasFor(html, themed), [html, themed])

  const loadOnce = () => {
    setAllowedLocally(true)
    remote.allowOnce()
  }

  return (
    <>
      {sanitized.blockedRemoteCount > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-secondary px-2 py-1 text-[11px] text-muted-foreground">
          <ImageOff size={12} className="shrink-0" />
          <span className="min-w-0 flex-1">
            Images blocked — loading them tells the sender you opened this.
          </span>
          <Button variant="ghost" size="xs" className="shrink-0" onClick={loadOnce}>
            Load images
          </Button>
          {/* Offered only with an address to attach it to: an empty sender
              would unblock every message whose `From` could not be parsed. */}
          {remote.sender !== null && (
            <Button
              variant="ghost"
              size="xs"
              className="shrink-0"
              onClick={() => {
                setAllowedLocally(true)
                remote.allowSenderAlways()
              }}
            >
              Always from this sender
            </Button>
          )}
        </div>
      )}
      <HtmlFrame
        html={sanitized.html}
        css={sanitized.css}
        palette={palette}
        allowRemoteContent={allowRemoteContent}
        label={label}
        registerAs={identity.key}
      />
    </>
  )
}

interface HtmlFrameProps {
  /** Sanitizer output. Nothing else may be passed. */
  html: string
  /** The message's own stylesheet, from the same sanitize call — its column
   *  layouts live in there, so dropping it stacks every multi-column mail. */
  css: string
  palette: MailPalette
  allowRemoteContent: boolean
  label: string
  /**
   * Publish this frame's document under this key, so in-thread find can reach
   * it ([[state/mail-frames]]). `null` for a block with no stable identity,
   * such as a calendar event description.
   */
  registerAs: string | null
}

/**
 * The content's own page.
 *
 * Written into rather than handed a `srcdoc`, because the app needs the
 * document (to size the frame and catch link clicks) on the same tick rather
 * than after a load event. The frame carries no `allow-scripts`, so nothing
 * inside it ever runs; only the app's script touches the inert document.
 */
function HtmlFrame({
  html,
  css,
  palette,
  allowRemoteContent,
  label,
  registerAs,
}: HtmlFrameProps): React.JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(0)

  // Layout, not passive: the frame has no height until it is measured, so an
  // ordinary effect would paint every block at zero height first and snap.
  useLayoutEffect(() => {
    const frame = ref.current
    const document_ = frame?.contentDocument
    if (document_ == null) return

    document_.open()
    document_.write(mailFrameDocument({ html, css, palette, allowRemoteContent }))
    document_.close()

    /**
     * A link must not navigate anything: inside the frame it would replace the
     * content with a live web page. Delegated, so it covers every anchor.
     */
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest('a[href]')
      if (anchor == null) return
      // Prevent first, decide second: an untrusted scheme must still not navigate.
      event.preventDefault()
      const href = openableLink(anchor.getAttribute('href'))
      if (href !== null) void window.holi.openExternal(href)
    }
    document_.addEventListener('click', onClick)

    /**
     * The frame has no intrinsic height, so it is measured and set. A frame
     * shorter than its content becomes its own scroll area inside the thread.
     *
     * **Observe `body`, not `documentElement`.** The root element's box *is*
     * the frame viewport (the height we just set), so an observer on it never
     * fires when the content grows. `body`'s box follows the content.
     *
     * `scrollHeight` is taken from both, and the larger wins: body margins are
     * outside the body's scroll box but inside the root's.
     */
    const measure = () =>
      setHeight(
        Math.max(
          document_.documentElement.scrollHeight,
          document_.body.scrollHeight,
          document_.body.offsetHeight,
        ),
      )
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(document_.body)
    // Capture: `load` on an <img> does not bubble.
    document_.addEventListener('load', measure, true)

    /**
     * ⌘F pressed **over the message** has to be forwarded out by hand: a
     * keydown inside an iframe does not cross the frame boundary, so React
     * never sees it.
     *
     * Re-dispatched onto the host frame element rather than through a callback
     * prop, so the pane's existing handler stays the one place that knows what
     * ⌘F means.
     */
    const onFrameKeyDown = (event: KeyboardEvent) => {
      if (!matchHotkey(event, '⌘F')) return
      event.preventDefault()
      frame?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          bubbles: true,
        }),
      )
    }
    document_.addEventListener('keydown', onFrameKeyDown)

    // Published last: the document is written and wired by this point, so a
    // searcher that reads the registry never gets a half-built page.
    const unregister = registerAs === null ? undefined : registerMailFrame(registerAs, document_)

    return () => {
      document_.removeEventListener('click', onClick)
      document_.removeEventListener('load', measure, true)
      document_.removeEventListener('keydown', onFrameKeyDown)
      observer.disconnect()
      unregister?.()
    }
  }, [html, css, palette, allowRemoteContent, registerAs])

  return (
    <iframe
      ref={ref}
      /**
       * **A fresh element when the policy widens, or the images never load.**
       *
       * A CSP delivered by `<meta>` joins the document's list of policies, and a
       * request must satisfy *every* one. `document.open()` does not clear the
       * ones already applied, so rewriting with a wider `img-src` leaves the
       * restrictive policy refusing every remote image. Only a new iframe sheds
       * a policy.
       *
       * The key is on the frame and not on `HtmlFrame`, so the measured height
       * survives the swap and the message does not collapse and spring back.
       */
      key={allowRemoteContent ? 'remote-allowed' : 'remote-blocked'}
      // `allow-same-origin` and nothing else. No `allow-scripts`: granting both
      // lets framed content drop its own sandbox.
      sandbox="allow-same-origin"
      aria-label={label}
      className="block w-full rounded-md border-0"
      style={{ height }}
    />
  )
}
