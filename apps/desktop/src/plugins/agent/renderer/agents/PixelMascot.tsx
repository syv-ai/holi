/**
 * A Holi's pixel figure, alive: idle it bobs, working it hops and chatters,
 * waiting on you it gets an idea (a bulb flickers over its head).
 *
 * Ported from MonoCode's `PixelMascot` (MIT, Copyright (c) 2026 Nick; see
 * NOTICE.md). The motion is in `agents.css`, paced off `--motion-inflight`,
 * and stops under reduced motion.
 */
import type { CSSProperties } from 'react'
import { cn } from '@/plugin-api'
import { BULB, PIXEL_GRID, pixelLayers, type PixelLayers, type PixelRect } from './pixel-mascots'
import './agents.css'

export type MascotStatus = 'idle' | 'working' | 'needs-you'

/** A stable blink offset, so mascots side by side do not blink in unison. */
function blinkDelay(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return `-${(hash % 5200) / 1000}s`
}

const VIEW_BOX = `0 0 ${PIXEL_GRID} ${PIXEL_GRID}`

function Rects({ rects }: { rects: readonly PixelRect[] }): React.JSX.Element {
  return (
    <>
      {rects.map(({ x, y, w, h, fill }, i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={fill} />
      ))}
    </>
  )
}

function Frame({
  layers,
  still,
  blink,
}: {
  layers: PixelLayers
  still: boolean
  blink: CSSProperties
}): React.JSX.Element {
  return (
    <>
      <Rects rects={layers.body} />
      <g className={still ? undefined : 'pixel-eyes-open'} style={blink}>
        <Rects rects={layers.open} />
      </g>
      {still ? null : (
        <g className="pixel-eyes-closed" style={blink}>
          <Rects rects={layers.closed} />
        </g>
      )}
    </>
  )
}

export function PixelMascot({
  name,
  color,
  status = 'idle',
  still = false,
  className,
}: {
  /** One of `HOLI_MASCOTS`; an unknown name draws the ghost. */
  name: string
  /** `#rrggbb`: the Holi's own colour. */
  color: string
  status?: MascotStatus
  /** No bob and no blink, for a figure repeated where motion would nag. */
  still?: boolean
  className?: string
}): React.JSX.Element {
  const working = status === 'working'
  const waiting = status === 'needs-you'
  const rest = pixelLayers(name, color)
  const talk = working ? pixelLayers(name, color, true) : null
  const blink: CSSProperties = { animationDelay: blinkDelay(name + color) }
  return (
    <svg
      aria-hidden="true"
      viewBox={VIEW_BOX}
      overflow="visible"
      shapeRendering="crispEdges"
      className={cn('pixel-mascot size-[18px] shrink-0', className)}
      data-mascot-status={status}
    >
      <g className={working ? 'pixel-hop' : still || waiting ? undefined : 'pixel-bob'}>
        {talk ? (
          <>
            <g className="pixel-frame-a">
              <Frame layers={rest} still={still} blink={blink} />
            </g>
            <g className="pixel-frame-b">
              <Frame layers={talk} still={still} blink={blink} />
            </g>
          </>
        ) : (
          <Frame layers={rest} still={still} blink={blink} />
        )}
      </g>
      {waiting ? (
        <g className="pixel-bulb" transform="translate(12.5 -2.5)">
          <Rects rects={BULB} />
        </g>
      ) : null}
    </svg>
  )
}
