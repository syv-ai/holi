/**
 * A destructive icon that becomes its own confirmation (rare-ui's delete
 * button): the bin grows, on the destructive background, into the act and a
 * way out. The confirmation comes before the act, never after it.
 *
 * It folds back when the pointer leaves, on Escape, and on the way out, so a
 * half-asked question never lingers on a row. With a `fuse` it also folds back
 * on its own, the time left draining across it: not answering is keeping.
 *
 * Two sizes. `sm` sits inside a row (a card's bin) and asks on the destructive
 * background, tight to the row it must not stretch. `md` stands on its own (a
 * column header) and asks roomily on a quiet surface: the act a solid
 * destructive button, the way out lit by a neutral background on hover.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
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
  const reduced = useReducedMotion() ?? false
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
  const md = size === 'md'

  useEffect(() => {
    if (!asking || fuse === undefined) return
    const timer = window.setTimeout(() => setAsking(false), fuse)
    return () => window.clearTimeout(timer)
  }, [asking, fuse])

  return (
    <motion.div
      layout={!reduced}
      transition={reduced ? instant : settle}
      style={{ borderRadius: 999 }}
      data-asking={asking ? '' : undefined}
      // A row under it is usually a click target of its own.
      onClick={(event) => event.stopPropagation()}
      onPointerLeave={() => setAsking(false)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !asking) return
        event.stopPropagation()
        setAsking(false)
      }}
      className={cn(
        'relative flex items-center overflow-hidden',
        asking && (md ? 'gap-1 bg-muted p-1' : 'bg-destructive text-destructive-foreground'),
        className,
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {asking ? (
          <motion.div key="ask" {...fade} className={cn('flex items-center', md && 'gap-1')}>
            {fuse !== undefined && (
              <motion.span
                aria-hidden
                className={cn(
                  'absolute inset-0 origin-left',
                  md ? 'bg-foreground/5' : 'bg-destructive-foreground/15',
                )}
                initial={{ scaleX: 1 }}
                animate={{ scaleX: 0 }}
                transition={{ duration: fuse / 1000, ease: 'linear' }}
              />
            )}
            <button
              type="button"
              autoFocus
              onClick={() => {
                setAsking(false)
                onConfirm()
              }}
              className={cn(
                'relative rounded-full whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-ring',
                md
                  ? 'h-6 bg-destructive px-3 text-xs font-medium text-destructive-foreground motion-respond hover:bg-destructive/85'
                  : 'px-2 py-0.5 text-[11px]',
              )}
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              aria-label={cancelLabel}
              onClick={() => setAsking(false)}
              className={cn(
                'relative grid place-items-center rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring',
                md
                  ? 'size-6 text-muted-foreground motion-respond hover:bg-accent hover:text-foreground'
                  : 'size-5',
              )}
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
