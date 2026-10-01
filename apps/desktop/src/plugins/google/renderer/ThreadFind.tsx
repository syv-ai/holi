/**
 * ⌘F inside the thread you are reading.
 *
 * [[MailView]] routes ⌘F between this and the list search on where the
 * keystroke came from. Mail bodies live in sandboxed frames, which makes this
 * harder than an ordinary find:
 *
 * 1. **The text is in other documents**, one per message, reached through
 *    `mail-frames.ts`. Result order comes from the thread's message order.
 * 2. **A collapsed message has no frame at all**, so a search expands the whole
 *    thread while it is open: a count that silently excludes what is collapsed
 *    reads as "not in this thread".
 * 3. **Scrolling to a match cannot use `scrollIntoView`**: the thread's scroller
 *    has to move, and it is in a different document from the match.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { Icon, IconButton, Input } from '@/primitives'
import { clearIn, findIn, setActiveMark } from './mail-find'
import { mailFrameFor, useMailFrameVersion } from './mail-frames'

/** Where a plain-text message body is marked in the app's own document, since a
 *  text-only message has no frame to register. Set by [[MailView]]'s `MessageBody`. */
export const MESSAGE_BODY_ATTR = 'data-holi-message'

export interface ThreadFindHandle {
  /** Every message in the thread, in the order they are read. */
  messageIds: string[]
  /** The thread's scroller, which is what actually moves. */
  scroller: HTMLElement | null
}

/**
 * Where one message's searchable content is: HTML bodies are in a frame,
 * plain-text ones are ordinary app DOM.
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
  // Bumped whenever a frame document is created or replaced (unblocking images,
  // switching theme), which takes its marks with it. Re-running the search is
  // the whole response.
  const frameVersion = useMailFrameVersion()

  useEffect(() => inputRef.current?.focus(), [])

  const [marks, setMarks] = useState<HTMLElement[]>([])

  /**
   * The matches, across every message, in reading order.
   *
   * **In an effect, not in render.** Searching *mutates* (it wraps text in
   * `<mark>`), and opening the find expands the collapsed messages in the same
   * commit: computed during render, the search would run before those bodies
   * exist. Recomputed wholesale, since the documents get rewritten underneath.
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
    // is a signal to re-read live DOM, not a value.
  }, [term, messageIds, scroller, frameVersion])

  // An out-of-range index after the term narrows the result set would show
  // "4/2" and scroll nowhere.
  const active = marks.length === 0 ? 0 : Math.min(index, marks.length - 1)

  useEffect(() => {
    if (marks.length === 0) return
    setActiveMark(marks, active)
    scrollToMark(marks[active]!, scroller)
  }, [marks, active, scroller])

  /** Every mark comes out on close, or the highlights would stay. */
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
      <Icon icon={Search} size="sm" tone="muted" />
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
      {/* Nothing until a term is typed. A live region, because the number
          changing IS the feedback for pressing Enter; the label also tells it
          apart from a thread's `1/2` position indicator. */}
      {term !== '' && (
        <span
          role="status"
          aria-label={marks.length === 0 ? 'no matches' : `match ${active + 1} of ${marks.length}`}
          className="shrink-0 text-[10px] text-muted-foreground tabular-nums"
        >
          {marks.length === 0 ? 'no matches' : `${active + 1}/${marks.length}`}
        </span>
      )}
      <IconButton
        icon={ChevronUp}
        label="previous match"
        tooltip="previous match (⇧⏎)"
        disabled={marks.length === 0}
        onClick={() => step(-1)}
      />
      <IconButton
        icon={ChevronDown}
        label="next match"
        tooltip="next match (⏎)"
        disabled={marks.length === 0}
        onClick={() => step(1)}
      />
      <IconButton icon={X} label="close find" onClick={onClose} />
    </div>
  )
}

/**
 * Bring a match into view by moving the THREAD's scroller.
 *
 * `mark.scrollIntoView()` does nothing useful: the mark's frame is sized to its
 * content and declares `overflow-y: hidden`. Bridged through viewport
 * coordinates, which both documents agree on.
 */
function scrollToMark(mark: HTMLElement, scroller: HTMLElement | null): void {
  if (scroller === null) return
  // jsdom has no `scrollBy`; a no-op there rather than a throw that takes the
  // reader down.
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
