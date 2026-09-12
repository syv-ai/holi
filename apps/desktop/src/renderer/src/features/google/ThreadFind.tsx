/**
 * ⌘F inside the thread you are reading.
 *
 * Pressing it used to open the *list* search — a Gmail query against the whole
 * mailbox — which is a reasonable thing to want and never what ⌘F means with a
 * conversation open in front of you. [[MailView]] routes between the two on
 * where the keystroke came from; this is the half that searches the thread.
 *
 * Three things make it harder than an ordinary find, and all three are
 * consequences of mail bodies living in sandboxed frames:
 *
 * 1. **The text is in other documents.** One per message, reached through
 *    [[state/mail-frames]]. The order of results comes from the thread's own
 *    message order, not from the registry.
 * 2. **A collapsed message has no frame at all**, so it cannot be searched and
 *    its matches cannot be counted. A search therefore expands the whole thread
 *    while it is open — a count that silently excludes what is collapsed is
 *    worse than no count, because it reads as "not in this thread".
 * 3. **Scrolling to a match cannot use `scrollIntoView`.** The frame is sized to
 *    its content and never scrolls internally, so the element's own scroll does
 *    nothing; what has to move is the thread's scroller, which is in a
 *    different document from the match.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { Button, Input, Tooltip } from '@/primitives'
import { clearIn, findIn, setActiveMark } from '../../lib/mail-find'
import { mailFrameFor, useMailFrameVersion } from '../../state/mail-frames'

/** Where a plain-text message body is marked in the app's own document. Set by
 *  [[MailView]]'s `MessageBody`, and the reason it exists: a text-only message
 *  has no frame to register. */
export const MESSAGE_BODY_ATTR = 'data-holi-message'

export interface ThreadFindHandle {
  /** Every message in the thread, in the order they are read. */
  messageIds: string[]
  /** The thread's scroller, which is what actually moves. */
  scroller: HTMLElement | null
}

/**
 * Where one message's searchable content is.
 *
 * Two possible homes, because a message is rendered two different ways: HTML
 * bodies go in a frame, plain-text ones are ordinary app DOM. Both are just an
 * `Element` to the search.
 */
function rootFor(id: string, scope: ParentNode): Element | null {
  const framed = mailFrameFor(id)
  if (framed !== undefined) return framed.body
  return scope.querySelector(`[${MESSAGE_BODY_ATTR}="${CSS.escape(id)}"]`)
}

export function ThreadFind({
  messageIds,
  scroller,
  onClose,
}: {
  messageIds: string[]
  scroller: HTMLElement | null
  onClose: () => void
}): React.JSX.Element {
  const [term, setTerm] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // Bumped whenever a frame document is created or replaced — unblocking images
  // or switching theme rewrites the page, and marks that were in the old one
  // are gone with it. Re-running the search is the whole response.
  const frameVersion = useMailFrameVersion()

  useEffect(() => inputRef.current?.focus(), [])

  const [marks, setMarks] = useState<HTMLElement[]>([])

  /**
   * The matches, across every message, in reading order.
   *
   * **In an effect, not in render**, for two reasons and the second is the one
   * that bit. Searching *mutates* — it wraps text in `<mark>` — and mutation
   * during render is not something React promises anything about. And opening
   * the find is what expands the collapsed messages, which happens in the very
   * same commit: computed during render, the search ran against a DOM where
   * those bodies did not exist yet, and reported a count for the one message
   * that had already been open. A layout effect runs after the commit, so the
   * text is there to be found.
   *
   * Recomputed wholesale rather than maintained incrementally: a search is
   * cheap next to anything else on this screen, and an incremental version
   * would have to reconcile against documents that get rewritten underneath it.
   */
  useLayoutEffect(() => {
    if (scroller === null) return
    const found: HTMLElement[] = []
    for (const id of messageIds) {
      const root = rootFor(id, scroller)
      if (root === null) continue
      found.push(...findIn(root, term))
    }
    setMarks(found)
    // `frameVersion` appears in the deps and nowhere in the body on purpose: it
    // is a signal to go and re-read live DOM, not a value. A frame rebuilt by an
    // image unblock or a theme change takes the marks that were in it with it.
  }, [term, messageIds, scroller, frameVersion])

  // An out-of-range index after the term narrows the result set would show
  // "4/2" and scroll nowhere.
  const active = marks.length === 0 ? 0 : Math.min(index, marks.length - 1)

  useEffect(() => {
    if (marks.length === 0) return
    setActiveMark(marks, active)
    scrollToMark(marks[active]!, scroller)
  }, [marks, active, scroller])

  /** Every mark comes out on the way past — leaving them would put permanent
   *  highlights in a thread nobody is searching any more. */
  useEffect(() => {
    return () => {
      if (scroller === null) return
      for (const id of messageIds) {
        const root = rootFor(id, scroller)
        if (root !== null) clearIn(root)
      }
    }
  }, [messageIds, scroller])

  const step = (by: number) => {
    if (marks.length === 0) return
    setIndex((previous) => {
      const from = Math.min(previous, marks.length - 1)
      return (from + by + marks.length) % marks.length
    })
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-divider px-3">
      <Search size={14} className="shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={term}
        onChange={(event) => {
          setTerm(event.target.value)
          setIndex(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          }
          if (event.key === 'Escape') onClose()
        }}
        placeholder="Find in this conversation"
        aria-label="find in conversation"
        className="h-7 text-xs"
      />
      {/* Says nothing until there is something to say. A "0/0" over an empty box
          is a result reported for a search nobody ran.

          A live region, because the number changing IS the feedback for pressing
          Enter — without it a screen reader hears nothing move. It also makes
          the counter findable on its own: `1/2` is what a two-message thread's
          position indicator says too, and the two mean entirely different
          things. */}
      {term !== '' && (
        <span
          role="status"
          aria-label={marks.length === 0 ? 'no matches' : `match ${active + 1} of ${marks.length}`}
          className="shrink-0 text-[10px] text-muted-foreground tabular-nums"
        >
          {marks.length === 0 ? 'no matches' : `${active + 1}/${marks.length}`}
        </span>
      )}
      <Tooltip content="previous match (⇧⏎)">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="previous match"
          disabled={marks.length === 0}
          onClick={() => step(-1)}
        >
          <ChevronUp size={14} />
        </Button>
      </Tooltip>
      <Tooltip content="next match (⏎)">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="next match"
          disabled={marks.length === 0}
          onClick={() => step(1)}
        >
          <ChevronDown size={14} />
        </Button>
      </Tooltip>
      <Tooltip content="close find">
        <Button variant="ghost" size="icon-xs" aria-label="close find" onClick={onClose}>
          <X size={14} />
        </Button>
      </Tooltip>
    </div>
  )
}

/**
 * Bring a match into view by moving the THREAD's scroller.
 *
 * `mark.scrollIntoView()` is the obvious call and does nothing useful: the mark
 * is inside a frame that is sized to its own content and declares
 * `overflow-y: hidden`, so there is no scrollable box around it. The element
 * that has to move is the reader's scroller, one document up.
 *
 * Bridged through viewport coordinates, which both documents agree on — the
 * frame's own layout offsets would need the frame's position added to them, and
 * every wrapper in between accounted for.
 */
function scrollToMark(mark: HTMLElement, scroller: HTMLElement | null): void {
  if (scroller === null) return
  // jsdom implements no layout and no scrolling — every rect is zero and
  // `scrollBy` does not exist. Bringing something into view is meaningless
  // where nothing has a position, so this is a no-op there rather than a throw
  // that takes the whole reader down with it.
  if (typeof scroller.scrollBy !== 'function') return

  const markRect = mark.getBoundingClientRect()
  const frame = mark.ownerDocument.defaultView?.frameElement ?? null
  const frameTop = frame === null ? 0 : frame.getBoundingClientRect().top
  const scrollerRect = scroller.getBoundingClientRect()

  // Where the match sits relative to the top of the visible thread.
  const offset = frameTop + markRect.top - scrollerRect.top
  const margin = 80
  if (offset >= margin && offset <= scrollerRect.height - margin) return
  scroller.scrollBy({ top: offset - margin })
}
