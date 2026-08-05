/**
 * Third-party HTML, rendered in a page of its own.
 *
 * Google hands Holi markup that a stranger wrote, in two places: a mail message
 * body, and a **calendar event description** — an invitation's description is
 * whoever-invited-you's HTML, dial-in blocks and all, and Google Calendar's own
 * UI renders it as markup. So both go down one path rather than two, and the
 * reasoning lives here once: [[mail-html]] decides what markup survives,
 * [[mail-frame]] decides what document it survives *in*, and neither is a
 * substitute for the other. Sanitized markup never lands in the app's document.
 *
 * Remote content is blocked until asked for, per block of HTML — the same
 * decision every mail client makes, for the same reason: an image fetched from
 * a sender's server is a read receipt nobody agreed to. A calendar invitation
 * is no different; a tracking pixel in a meeting description is still a pixel.
 *
 * The `mail-` module names predate the calendar using them. They are not
 * mail-specific and are deliberately not renamed — the sanitizer and the frame
 * document carry their own test suites under those names, and churning them
 * would move the security-relevant code without changing it.
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

interface SandboxedHtmlProps {
  /** Raw and untrusted. Sanitizing happens **here** — a caller must not pre-sanitize
   *  and must not pass anything it has already put through the sanitizer twice. */
  html: string
  /** Names the frame for a screen reader, e.g. `message from Jane`. */
  label: string
  /**
   * Who this block belongs to, so an unblock can be remembered.
   *
   * Optional because not every block has an identity worth keeping: a calendar
   * event description is re-rendered from whatever the agenda last fetched, and
   * "always load images from this event" is not a sentence. Omitting it means
   * the choice lives and dies with this component, which is where it lived for
   * everything before.
   */
  identity?: RemoteContentIdentity
}

const NO_IDENTITY: RemoteContentIdentity = { key: null, sender: null }

/**
 * One block of untrusted HTML: a sandboxed frame, with images held back.
 *
 * Re-sanitizing from the *original* HTML when the user unblocks (rather than
 * stashing the stripped URLs and putting them back) keeps one code path —
 * whatever renders has been through the sanitizer under the current setting,
 * always.
 *
 * **The unblock is remembered outside this component** ([[state/mail-images]]),
 * and it has to be: the reader unmounts every time a thread closes, so a choice
 * held in local state was lost on the way out and the banner came back on the
 * next open. What stays local is only the fallback for a block with no identity.
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
  // message — see `bringsOwnDesign`.
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
          {/* The standing version of the same permission. Offered only when
              there is an address to attach it to, because "always" with nobody
              to be always about would store an empty sender and unblock every
              message whose `From` could not be parsed. */}
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
        palette={palette}
        allowRemoteContent={allowRemoteContent}
        label={label}
      />
    </>
  )
}

interface HtmlFrameProps {
  /** Sanitizer output. Nothing else may be passed. */
  html: string
  palette: MailPalette
  allowRemoteContent: boolean
  label: string
}

/**
 * The content's own page.
 *
 * Written into rather than handed a `srcdoc`, because the app needs the
 * document anyway — to size the frame and to catch link clicks — and writing
 * gives it on the same tick instead of after a load event. Everything reaching
 * in here is the *app's* script touching an inert document; the frame carries
 * no `allow-scripts`, so nothing inside it ever runs.
 */
function HtmlFrame({
  html,
  palette,
  allowRemoteContent,
  label,
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
    document_.write(mailFrameDocument({ html, palette, allowRemoteContent }))
    document_.close()

    /**
     * A link must not navigate anything — inside the frame it would replace the
     * content with a live web page, which is the one place remote content was
     * being kept out of. Delegated, so it covers every anchor in markup nobody
     * here wrote.
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
     * The frame has no intrinsic height, so it is measured and set — and the
     * measurement has to be right, because a frame shorter than its content
     * does not merely clip: it becomes its own little scroll area inside the
     * thread, which is the one thing a mail reader must never do.
     *
     * **Observe `body`, not `documentElement`.** The root element's box *is*
     * the frame viewport — the height we just set — so a ResizeObserver on it
     * watches our own output and never fires when the content grows. That is a
     * feedback loop with no signal in it, and it is why a message could end up
     * short and scrollable. `body`'s box follows the content.
     *
     * `scrollHeight` is taken from both, and the larger wins: margins on the
     * body are outside its own scroll box but inside the root's, and mail is
     * full of body margins.
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

    return () => {
      document_.removeEventListener('click', onClick)
      document_.removeEventListener('load', measure, true)
      observer.disconnect()
    }
  }, [html, palette, allowRemoteContent])

  return (
    <iframe
      ref={ref}
      /**
       * **A fresh element when the policy widens, or the images never load.**
       *
       * A CSP delivered by `<meta>` joins the document's list of policies, and
       * a request has to satisfy *every* policy in it. `document.open()` does
       * not clear the ones already applied — so rewriting the document with a
       * wider `img-src` adds a permissive policy underneath the restrictive one
       * that is still there, and `img-src data:` goes on refusing every remote
       * image. Rewriting is enough for the markup and not enough for the browser.
       *
       * The symptom was exact: "Load images" restored the `src`, the banner
       * went away, and nothing appeared until you left the message and came
       * back — because that destroyed the iframe and built a new document,
       * which is the only way a document sheds a policy. Keying on the flag
       * does deliberately what navigating away did by accident.
       *
       * The key is on the frame and not on `HtmlFrame`, so the measured height
       * survives the swap and the message does not collapse to nothing and
       * spring back while the new document is written.
       */
      key={allowRemoteContent ? 'remote-allowed' : 'remote-blocked'}
      // `allow-same-origin` and nothing else. No `allow-scripts` — granting both
      // is the footgun that lets framed content drop its own sandbox.
      sandbox="allow-same-origin"
      aria-label={label}
      className="block w-full rounded-md border-0"
      style={{ height }}
    />
  )
}
