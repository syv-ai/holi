/**
 * A Holi's face: one of the pixel personas (`personas.ts`), in its everyday
 * look under the light theme and suited up as a superhero under the dark.
 *
 * Alive, it says what its agent is doing with the figure's own frames: idle it
 * blinks now and then; working it talks (the mouth opens and closes); waiting
 * on you it waves (the whole figure) or calls out (the head-and-shoulders
 * window, where the raised hand would fall outside the frame). The frames
 * swap on `step-end` in `pixel-persona.css`, paced off `--motion-inflight`;
 * reduced motion holds the first.
 *
 * Drawn at whole multiples of the sprite grid (`scale` screen pixels to a
 * sprite pixel), so it stays sharp. The Holi's own colour is the plate behind
 * it: categorical identity that frames the figure without repainting it.
 */
import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import { useHeroMode } from './hero-mode'
import { cropBox, personaRuns, type Frame, type PersonaCrop, type Run } from './personas'
import './pixel-persona.css'

export type MascotStatus = 'idle' | 'working' | 'needs-you'

const REST: Frame = { pose: 'rest', mouth: 'smile', blink: false }
const BLINK: Frame = { pose: 'rest', mouth: 'smile', blink: true }
const SHUT: Frame = { pose: 'rest', mouth: 'closed', blink: false }
const OPEN: Frame = { pose: 'rest', mouth: 'open', blink: false }
const WAVE_A: Frame = { pose: 'waveA', mouth: 'open', blink: false }
const WAVE_B: Frame = { pose: 'waveB', mouth: 'smile', blink: false }

/** The two frames a state alternates between; the first is what reduced
 *  motion and `still` show. */
function framesFor(status: MascotStatus, crop: PersonaCrop, still: boolean): readonly Frame[] {
  if (still) return [REST]
  if (status === 'working') return [SHUT, OPEN]
  if (status === 'needs-you') return crop === 'full' ? [WAVE_A, WAVE_B] : [OPEN, REST]
  return [REST, BLINK]
}

/** A stable offset into the loop, so figures side by side do not blink in unison. */
function phase(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return `-${(hash % 5200) / 1000}s`
}

function Runs({ runs }: { runs: readonly Run[] }): React.JSX.Element {
  return (
    <>
      {runs.map(({ x, y, w, fill }) => (
        <rect key={`${x},${y}`} x={x} y={y} width={w} height={1} fill={fill} />
      ))}
    </>
  )
}

export function PixelPersona({
  name,
  color,
  status = 'idle',
  still = false,
  crop = 'head',
  scale = 1,
  muted = false,
  className,
}: {
  /** One of `HOLI_MASCOTS` (an older arcade name maps onto its stand-in). */
  name: string
  /** `#rrggbb`: the Holi's own colour, the plate behind the figure. */
  color: string
  status?: MascotStatus
  /** One frame, no loop: for a figure repeated where motion would nag. */
  still?: boolean
  /** The whole figure, or the head-and-shoulders window for small slots. */
  crop?: PersonaCrop
  /** Screen pixels to a sprite pixel: a whole number, so it stays sharp. */
  scale?: number
  /** Drained of colour: a Holi whose file does not parse. */
  muted?: boolean
  className?: string
}): React.JSX.Element {
  const hero = useHeroMode()
  const box = cropBox(crop)
  const k = Math.max(1, Math.round(scale))
  const frames = framesFor(status, crop, still)
  const offset: CSSProperties = { animationDelay: phase(name + color) }
  // The plate: a disc behind the head, or behind the shoulders of the whole figure.
  const plate = crop === 'head' ? { cx: 16, cy: 12, r: 10 } : { cx: 16, cy: 16, r: 15 }
  return (
    <svg
      aria-hidden="true"
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      width={box.w * k}
      height={box.h * k}
      overflow="visible"
      shapeRendering="crispEdges"
      className={cn('pixel-persona-root shrink-0', muted && 'grayscale opacity-60', className)}
      data-persona-status={still ? 'still' : status}
    >
      <circle {...plate} fill={color} className="pixel-persona-plate" shapeRendering="auto" />
      {frames.map((frame, i) => (
        <g
          key={i}
          className={
            frames.length > 1 ? (i === 0 ? 'pixel-persona-a' : 'pixel-persona-b') : undefined
          }
          style={frames.length > 1 ? offset : undefined}
        >
          <Runs runs={personaRuns(name, frame, hero, crop)} />
        </g>
      ))}
    </svg>
  )
}
