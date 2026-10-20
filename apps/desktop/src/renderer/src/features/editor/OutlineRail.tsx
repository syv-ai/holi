/**
 * The outline rail at the editor's right edge (after ReUI's page editor,
 * docs/features/editor.md): one short tick per heading, longer for a higher
 * level, the section you are reading lit. Hovering or focusing it opens the
 * contents beside it on the menus' surface; a heading there scrolls to it.
 *
 * Shown from two headings up: one heading is a title, not something to
 * navigate. Ticks never move the text, and the panel floats over the margin.
 */
import { EditorView } from '@codemirror/view'
import { useEffect, useState, type KeyboardEvent } from 'react'
import { Button } from '@/primitives'
import { cn } from '@/lib/cn'
import { currentHeading, outlineOf, type OutlineHeading } from '@/editor/outline'

/** Re-reading the outline waits for typing to pause. */
const QUIET_MS = 250

const TICK = ['w-4', 'w-3', 'w-2', 'w-2', 'w-2', 'w-2'] as const

export function OutlineRail({ view }: { view: EditorView | null }): React.JSX.Element | null {
  const [headings, setHeadings] = useState<OutlineHeading[]>([])
  const [current, setCurrent] = useState(-1)

  useEffect(() => {
    if (view === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let list = outlineOf(view.state)
    setHeadings(list)
    // The section at the top of what is on screen, a little below the edge
    // so a heading just scrolled to counts as read.
    const track = () => {
      const top = view.scrollDOM.getBoundingClientRect().top + 48
      const pos = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 1, y: top })
      setCurrent(currentHeading(list, pos ?? view.viewport.from))
    }
    track()
    const reread = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        list = outlineOf(view.state)
        setHeadings(list)
        track()
      }, QUIET_MS)
    }
    // Every transaction reaches the DOM as input; cheap to listen for, and
    // the outline is only rebuilt once the typing pauses.
    view.contentDOM.addEventListener('input', reread)
    view.scrollDOM.addEventListener('scroll', track, { passive: true })
    return () => {
      clearTimeout(timer)
      view.contentDOM.removeEventListener('input', reread)
      view.scrollDOM.removeEventListener('scroll', track)
    }
  }, [view])

  if (view === null || headings.length < 2) return null
  const top = Math.min(...headings.map((h) => h.level))

  /** One tab stop for the list, on the current heading; ↑ ↓ Home End move
   *  inside it and wrap at the ends (ReUI's outline list). */
  const stop = current < 0 ? 0 : current
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    const i = rows.indexOf(e.target as HTMLButtonElement)
    if (i === -1) return
    const last = rows.length - 1
    const next =
      e.key === 'ArrowDown'
        ? i === last
          ? 0
          : i + 1
        : e.key === 'ArrowUp'
          ? i === 0
            ? last
            : i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (next === null) return
    e.preventDefault()
    rows[next]?.focus()
  }

  const go = (h: OutlineHeading) => {
    view.dispatch({
      selection: { anchor: h.from },
      effects: EditorView.scrollIntoView(h.from, { y: 'start', yMargin: 24 }),
    })
    view.focus()
  }

  return (
    <nav
      aria-label="Outline"
      className="group/outline absolute top-1/2 right-0 z-10 flex -translate-y-1/2 items-center"
    >
      {/* The contents, floated left of the ticks while the rail is hovered or
          holds focus. */}
      <div
        onKeyDown={onKeyDown}
        className={cn(
          'pointer-events-none absolute top-1/2 right-full max-h-[60vh] w-60 -translate-y-1/2 translate-x-1 overflow-y-auto rounded-lg bg-popover p-1 opacity-0 shadow-popover',
          'motion-respond',
          'group-focus-within/outline:pointer-events-auto group-focus-within/outline:translate-x-0 group-focus-within/outline:opacity-100',
          'group-hover/outline:pointer-events-auto group-hover/outline:translate-x-0 group-hover/outline:opacity-100',
        )}
      >
        {headings.map((h, i) => (
          <Button
            key={`${h.from}:${h.text}`}
            variant="ghost"
            size="sm"
            aria-current={i === current ? 'location' : undefined}
            tabIndex={i === stop ? 0 : -1}
            className={cn(
              'h-7 w-full min-w-0 justify-start rounded-md px-2 text-nav font-normal text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
              'aria-[current=location]:text-foreground',
              h.level === top && 'font-medium',
            )}
            style={{ paddingInlineStart: `${0.5 + (h.level - top) * 0.75}rem` }}
            onClick={() => go(h)}
          >
            <span className="truncate">{h.text}</span>
          </Button>
        ))}
      </div>
      {/* The ticks: the rail's resting face, and its hover target. */}
      <div aria-hidden className="flex flex-col items-end gap-2 py-3 pr-3 pl-4">
        {headings.map((h, i) => (
          <span
            key={`${h.from}:${h.text}`}
            className={cn(
              'h-0.5 rounded-full motion-respond',
              TICK[Math.min(5, h.level - top)],
              i === current ? 'bg-foreground/70' : 'bg-foreground/20',
            )}
          />
        ))}
      </div>
    </nav>
  )
}
