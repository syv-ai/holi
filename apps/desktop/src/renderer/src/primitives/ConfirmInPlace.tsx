/**
 * A destructive icon that becomes its own confirmation (rare-ui's delete
 * button): the bin grows into the act. The confirmation comes before the act,
 * never after it.
 *
 * It folds back on Escape and on the way out, so a half-asked question never
 * lingers on a row. Without a `fuse` it also folds when the pointer leaves.
 * With one, the time left sweeps across it and it folds when the sweep ends,
 * unless the pointer is still on it, in which case it waits for the pointer
 * to leave: not answering is keeping, but a question being read stays open.
 *
 * Two sizes. `sm` sits inside a row (a card's bin): the act and a ✕, tight to
 * the row it must not stretch. `md` stands on its own (a column header): one
 * solid pill that reads the act, the fuse a shade crossing it behind the words.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { Icon, type IconGlyph } from './Icon'
import { instant, settle } from './springs'

export function ConfirmInPlace({
  label,
  confirmLabel,
  cancelLabel = 'Keep',
  icon = Trash2,
  fuse,
  size = 'sm',
  onConfirm,
  className,
}: {
  /** The bin's accessible name: "Delete Fix login". */
  label: string
  /** The act, as the button that commits it reads: "Delete". */
  confirmLabel: string
  cancelLabel?: string
  icon?: IconGlyph
  /** Milliseconds the question stays open unanswered. */
  fuse?: number
  size?: 'sm' | 'md'
  onConfirm: () => void
  className?: string
}): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  /** The fuse has run out: the next leave folds it. */
  const [burnt, setBurnt] = useState(false)
  const hovered = useRef(false)
  const reduced = useReducedMotion() ?? false
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
  const md = size === 'md'

  const fold = () => {
    setAsking(false)
    setBurnt(false)
  }

  useEffect(() => {
    if (!asking || fuse === undefined) return
    const timer = window.setTimeout(() => {
      if (hovered.current) setBurnt(true)
      else fold()
    }, fuse)
    return () => window.clearTimeout(timer)
  }, [asking, fuse])

  const confirm = () => {
    fold()
    onConfirm()
  }

  return (
    <motion.div
      layout={!reduced}
      transition={reduced ? instant : settle}
      style={{ borderRadius: 999 }}
      data-asking={asking ? '' : undefined}
      // A row under it is usually a click target of its own.
      onClick={(event) => event.stopPropagation()}
      onPointerEnter={() => (hovered.current = true)}
      onPointerLeave={() => {
        hovered.current = false
        if (fuse === undefined || burnt) fold()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !asking) return
        event.stopPropagation()
        fold()
      }}
      className={cn(
        'relative flex items-center overflow-hidden',
        asking && !md && 'bg-destructive text-destructive-foreground',
        className,
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {asking && md ? (
          <motion.button
            key="ask"
            type="button"
            autoFocus
            {...fade}
            onClick={confirm}
            className="relative h-8 overflow-hidden rounded-full bg-destructive px-5 text-xs font-medium whitespace-nowrap text-destructive-foreground outline-none motion-respond hover:bg-destructive/90 focus-visible:ring-1 focus-visible:ring-ring"
          >
            {fuse !== undefined && (
              // The time left: a shade crossing from the right, behind the
              // words. It rests at the end while the pointer stays.
              <motion.span
                aria-hidden
                className="absolute inset-0 origin-right bg-background/25"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={reduced ? instant : { duration: fuse / 1000, ease: 'linear' }}
              />
            )}
            <span className="relative">{confirmLabel}</span>
          </motion.button>
        ) : asking ? (
          <motion.div key="ask" {...fade} className="flex items-center">
            <button
              type="button"
              autoFocus
              onClick={confirm}
              className="rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              aria-label={cancelLabel}
              onClick={fold}
              className="grid size-5 place-items-center rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Icon icon={X} size="sm" />
            </button>
          </motion.div>
        ) : (
          <motion.button
            key="bin"
            type="button"
            aria-label={label}
            {...fade}
            onClick={() => setAsking(true)}
            className={cn(
              'grid place-items-center rounded-full text-icon outline-none motion-respond hover:text-icon-active focus-visible:ring-1 focus-visible:ring-ring',
              md ? 'size-8 hover:bg-accent' : 'size-5',
            )}
          >
            <Icon icon={icon} size="sm" />
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
