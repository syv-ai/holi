/**
 * Text whose strikethrough draws across it (rare-ui's task list). The line is
 * a background gradient growing from 0 to 100% rather than `line-through`,
 * which cannot animate; `box-decoration-break: clone` gives a wrapped title a
 * line on every row. Struck, the text also recedes to the muted colour.
 *
 * `onStruck` fires when the line has finished drawing or withdrawing.
 */
import { motion, useReducedMotion } from 'motion/react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import { check, instant } from './springs'

const LINE: CSSProperties = {
  backgroundImage: 'linear-gradient(currentColor, currentColor)',
  backgroundRepeat: 'no-repeat',
  backgroundPosition: '0 55%',
  boxDecorationBreak: 'clone',
  WebkitBoxDecorationBreak: 'clone',
}

export function StrikeText({
  text,
  struck,
  onStruck,
  className,
}: {
  text: string
  struck: boolean
  onStruck?: () => void
  className?: string
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  return (
    <motion.span
      style={LINE}
      data-struck={struck ? '' : undefined}
      className={cn(
        'motion-respond',
        struck ? 'text-muted-foreground' : 'text-foreground',
        className,
      )}
      initial={false}
      animate={{ backgroundSize: `${struck ? 100 : 0}% 1.5px` }}
      transition={reduced ? instant : check.strike}
      onAnimationComplete={onStruck}
    >
      {text}
    </motion.span>
  )
}
