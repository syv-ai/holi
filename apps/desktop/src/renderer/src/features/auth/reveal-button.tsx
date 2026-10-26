/**
 * A mark that becomes a labelled button: a circle holding an icon that, on
 * hover or keyboard focus, grows around the icon into a pill and says what it
 * does. After Bencho's `Seek` (MIT, bencho.dev/licence), a search icon that
 * becomes a search field, with the field swapped for a label.
 *
 * **One object, not two.** The obvious build is an icon that fades out and a
 * button that fades in, and two things swapping is never mistaken for one
 * thing changing, however well the crossfade is tuned. So there is a single
 * box whose WIDTH is the state, and the icon and the label are both inside it
 * the whole time. Which makes the problems geometry rather than choreography:
 *
 * - The icon never moves relative to the box. It sits at a fixed inset from
 *   the start edge, and at the closed width that inset centres it, since
 *   `(SHUT - ICON) / 2` is also the padding the open pill wants. So the icon
 *   travelling across the page is not an animation anybody wrote; it is the
 *   box growing around a mark that stayed put.
 * - The box grows from its middle (its holder centres it), so the composition
 *   is centred at every frame. Growing from one edge either pins the icon and
 *   throws the label off-centre, or slides the icon across the page.
 * - Height never changes and the corner is fully round at every width, so the
 *   shape is one rule rather than a tween with two ends: at `SHUT` a circle,
 *   open a pill, the same statement.
 *
 * Everything else derives from how far through the width's spring it is: the
 * label arrives in the last part of it, sliding a few pixels out of the icon,
 * so it reads as having come out of the mark rather than faded up where it
 * stood. There is one number, so nothing can arrive at the wrong time.
 *
 * **The press is a real beat.** A press compresses the object before it acts,
 * because a thing that yields before it moves reads as having been pushed, and
 * a thing that only moves reads as having been triggered.
 *
 * The label is always in the DOM, so it is the button's accessible name at
 * every width. `open` holds the pill open, for a label that must be read
 * without hovering (a status, "Try again"). Reduced motion keeps the change
 * and drops the travel.
 */
import {
  motion,
  useReducedMotion,
  useSpring,
  useTransform,
  type HTMLMotionProps,
} from 'motion/react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import type { IconGlyph } from '@/lib/icon-glyph'

/** A firm spring with the faintest settle, so the pill arrives rather than stops. */
const reveal = { stiffness: 420, damping: 30 } as const

/** The closed object, a circle, so the width IS the height. */
const SHUT = 40
/** The icon: `Icon`'s `md`, at 0.4 of its circle, in with the app's other
 *  round icon buttons; its inset is the number doing two jobs above. */
const ICON = 16
const INSET = (SHUT - ICON) / 2
/** From the icon to the label, and from the label to the far edge. The far
 *  side is a little wider than the near, because the icon's own ink sits
 *  inside its box and the text's does not. */
const GAP = 8
const TAIL = 16

export type RevealButtonProps = Omit<HTMLMotionProps<'button'>, 'children'> & {
  icon: IconGlyph
  label: ReactNode
  /** Hold the pill open, whatever the pointer does. */
  open?: boolean
}

export function RevealButton({
  icon: Glyph,
  label,
  open: held = false,
  className,
  disabled,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...props
}: RevealButtonProps) {
  const reduced = useReducedMotion() ?? false
  const text = useRef<HTMLSpanElement>(null)
  const [labelWidth, setLabelWidth] = useState(0)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)

  // The label's own width decides the pill's; it is measured, not guessed,
  // so a longer label ("Opening GitHub…") makes a longer pill.
  useLayoutEffect(() => {
    if (text.current) setLabelWidth(text.current.scrollWidth)
  }, [label])

  const span = INSET + ICON + GAP + labelWidth + TAIL
  const open = held || hovered || focused
  const width = useSpring(SHUT, reveal)
  useLayoutEffect(() => {
    const target = open ? span : SHUT
    if (reduced) width.jump(target)
    else width.set(target)
  }, [open, span, reduced, width])

  /* how far through the transformation, 0 shut and 1 open; the label comes
     in the last part of it, once there is somewhere for it to be */
  const say = useTransform(width, [SHUT + (span - SHUT) * 0.55, span], [0, 1], { clamp: true })
  const slide = useTransform(say, [0, 1], [-6, 0])

  return (
    <motion.button
      type="button"
      disabled={disabled}
      style={{ width, height: SHUT }}
      whileTap={reduced || disabled ? undefined : { scale: 0.94 }}
      className={cn(
        'relative inline-flex shrink-0 items-center overflow-hidden rounded-full bg-secondary text-secondary-foreground outline-none motion-respond hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-70',
        className,
      )}
      onPointerEnter={(e) => {
        setHovered(true)
        onPointerEnter?.(e)
      }}
      onPointerLeave={(e) => {
        setHovered(false)
        onPointerLeave?.(e)
      }}
      // Keyboard focus opens it as hover does; a click's focus does not, or
      // the pill would stay open after the pointer has gone.
      onFocus={(e) => {
        setFocused(e.currentTarget.matches(':focus-visible'))
        onFocus?.(e)
      }}
      onBlur={(e) => {
        setFocused(false)
        onBlur?.(e)
      }}
      {...props}
    >
      <span
        aria-hidden="true"
        className="absolute top-1/2 flex -translate-y-1/2"
        style={{ insetInlineStart: INSET }}
      >
        <Glyph aria-hidden className="size-4 shrink-0" />
      </span>
      <motion.span
        ref={text}
        className="absolute top-1/2 -translate-y-1/2 text-sm font-medium whitespace-nowrap"
        style={{ insetInlineStart: INSET + ICON + GAP, opacity: say, x: slide }}
      >
        {label}
      </motion.span>
    </motion.button>
  )
}
