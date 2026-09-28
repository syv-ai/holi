/**
 * A destructive icon whose confirmation is an undo (rare-ui's confirm in
 * place): pressed, it acts at once as far as the person can see, and the same
 * pill springs wide to say so and offer Undo while a fuse burns down. Nothing
 * opens over the page, and the choice stays under the cursor that made it.
 *
 * **The act is held, not reversed.** `onStart` hides what is going; only when
 * the fuse runs out does `onCommit` do it. Undo is `onUndo` before anything
 * irreversible has happened, so it never has to put anything back. Leaving
 * (unmounting) mid-fuse is an undo: an act nobody saw finish does not happen.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { Icon, type IconGlyph } from './Icon'
import { instant, settle } from './springs'

/** How long the undo stays offered. */
const GRACE = 4000

export function UndoInPlace({
  label,
  doneLabel,
  icon = Trash2,
  onStart,
  onUndo,
  onCommit,
  className,
}: {
  /** The icon's accessible name: "Delete every done task". */
  label: string
  /** What the pill says once pressed: "25 deleted". */
  doneLabel: string
  icon?: IconGlyph
  onStart: () => void
  onUndo: () => void
  onCommit: () => void
  className?: string
}): React.JSX.Element {
  const [held, setHeld] = useState(false)
  const reduced = useReducedMotion() ?? false
  const timer = useRef<number | undefined>(undefined)
  // The latest callbacks, so the fuse and the unmount act on current props.
  const calls = useRef({ onUndo, onCommit })
  calls.current = { onUndo, onCommit }
  const heldRef = useRef(false)

  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      if (heldRef.current) calls.current.onUndo()
    },
    [],
  )

  const start = () => {
    heldRef.current = true
    setHeld(true)
    onStart()
    timer.current = window.setTimeout(() => {
      heldRef.current = false
      setHeld(false)
      calls.current.onCommit()
    }, GRACE)
  }
  const undo = () => {
    window.clearTimeout(timer.current)
    heldRef.current = false
    setHeld(false)
    onUndo()
  }

  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
  return (
    <motion.div
      layout={!reduced}
      transition={reduced ? instant : settle}
      style={{ borderRadius: 999 }}
      data-held={held ? '' : undefined}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        'relative flex items-center overflow-hidden',
        held && 'bg-muted text-foreground',
        className,
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {held ? (
          <motion.div key="held" {...fade} className="flex items-center gap-2 py-0.5 pr-0.5 pl-2">
            {/* The fuse: a fill draining under the words, not a bar. */}
            <motion.span
              aria-hidden
              className="absolute inset-0 origin-left bg-foreground/10"
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: GRACE / 1000, ease: 'linear' }}
            />
            <span className="relative flex items-center gap-1 text-[11px] whitespace-nowrap">
              <Icon icon={Check} size="sm" />
              {doneLabel}
            </span>
            <button
              type="button"
              autoFocus
              onClick={undo}
              className="relative flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium outline-none motion-respond hover:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Icon icon={Undo2} size="sm" />
              Undo
            </button>
          </motion.div>
        ) : (
          <motion.button
            key="icon"
            type="button"
            aria-label={label}
            {...fade}
            onClick={start}
            className="grid size-5 place-items-center rounded-full text-icon outline-none motion-respond hover:text-icon-active focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon icon={icon} size="sm" />
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
