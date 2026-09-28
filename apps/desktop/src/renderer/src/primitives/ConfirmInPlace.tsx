/**
 * A destructive icon that becomes its own confirmation (rare-ui's delete
 * button): the bin grows, on the destructive background, into the act and a
 * way out. The confirmation comes before the act, never after it.
 *
 * It folds back when the pointer leaves, on Escape, and on the way out, so a
 * half-asked question never lingers on a row.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { Icon, type IconGlyph } from './Icon'
import { instant, settle } from './springs'

export function ConfirmInPlace({
  label,
  confirmLabel,
  cancelLabel = 'Keep',
  icon = Trash2,
  onConfirm,
  className,
}: {
  /** The bin's accessible name: "Delete Fix login". */
  label: string
  /** The act, as the button that commits it reads: "Delete". */
  confirmLabel: string
  cancelLabel?: string
  icon?: IconGlyph
  onConfirm: () => void
  className?: string
}): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  const reduced = useReducedMotion() ?? false
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
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
        'flex items-center overflow-hidden',
        asking && 'bg-destructive text-destructive-foreground',
        className,
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {asking ? (
          <motion.div key="ask" {...fade} className="flex items-center">
            <button
              type="button"
              autoFocus
              onClick={() => {
                setAsking(false)
                onConfirm()
              }}
              className="rounded-full px-2 py-0.5 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              aria-label={cancelLabel}
              onClick={() => setAsking(false)}
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
            className="grid size-5 place-items-center rounded-full text-icon outline-none motion-respond hover:text-icon-active focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon icon={icon} size="sm" />
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
