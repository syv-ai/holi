/**
 * The empty view's arcade: a dot grid that melts into the pane behind its
 * content, where the vault's Holis play Paper run (`paperRun.ts`) by
 * themselves; and, once someone takes control (`ArcadeTakeControl`), the
 * same board over the whole pane at full brightness, with a thin HUD along
 * its top.
 *
 * Ported from MonoCode's `features/terminal/ui/TerminalGridBackground.tsx`
 * (https://github.com/hardbeat920/monocode), MIT License, Copyright (c) 2026
 * Nick; see LICENSE in this folder. The canvas renderer is theirs: the stamped
 * cells, the cell outlines blitted from a canvas of their own, the sprites,
 * the eased speech bubble, the frame-capped loop, take-control and Escape.
 * Holi's changes: one game, so no slider; its own cast drawn from the Holis'
 * pixel mascots; colours read off the theme's tokens; a keep-out the content
 * marks (`data-arcade-keepout`); no autoplay under reduced motion; the loop
 * parks while the view is hidden or off screen; the take-control pill lives
 * in the content's flow rather than over it; and the HUD and the pill are
 * Holi's own components.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react"

import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { pixelLayers } from "@/composites/pixel-mascot/pixel-mascots"
import { cn } from "@/lib/cn"

import {
  ARCADE_MODES,
  type ArcadeCastMember,
  type ArcadeMode,
  type ArcadeSprite,
  type CellRect,
  type GridArcade,
} from "./gridArcade"
import { createPaperRun, stackScore } from "./paperRun"
import { drawSpeechBubble } from "./speechBubble"

const CELL = 6
const GAP = 1
const PITCH = CELL + GAP
/** The cell outlines: there, and no more. */
const BORDER_OPACITY = 0.04
const PEAK_OPACITY = 0.72
/** Idle, the board sits behind what you read: this much of a game's light. */
const IDLE_DIM = 0.3
/** The Holis themselves are paint, so they dim harder than the cells. */
const IDLE_SPRITE_DIM = 0.4
const BUBBLE_OPACITY = 0.95
const IDLE_BUBBLE_OPACITY = 0.7

/**
 * Idle, the board melts into the pane rather than reading as a layer: full
 * under the top of the content, gone by the foot (MonoCode's fade), and
 * softened at the sides.
 */
const IDLE_MASK: CSSProperties = {
  maskImage:
    "linear-gradient(to bottom, #000 45%, transparent 100%), linear-gradient(to right, transparent, #000 10%, #000 90%, transparent)",
  maskComposite: "intersect",
}
/** Under the logo (the keep-out): a whisper of the board. */
const KEEP_DIM = 0.12
/** Cells over which the keep-out's dimming eases back to the open board. */
const KEEP_FEATHER = 6
/** Sprites sit inside their tile rather than spilling over it. */
const SPRITE_SCALE = 0.9
/** How hard the bubble chases its speaker; sprites move cell by cell. */
const BUBBLE_EASE = 0.2
const FRAME_MS = 33

const HEADING: Record<string, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  w: { x: 0, y: -1 },
  a: { x: -1, y: 0 },
  s: { x: 0, y: 1 },
  d: { x: 1, y: 0 },
}

/** A conflict, in pixels of a 5×5 box: a cross, the shape of "these disagree". */
const CONFLICT_ART = ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"]

const MODE_LABEL: Record<ArcadeMode, string> = {
  low: "Slow",
  mid: "Steady",
  hard: "Fast",
}

/** The theme's colours, as CSS colour strings the canvas takes directly.
 *  The tokens are oklch(), so they are never parsed into numbers: the canvas
 *  is handed the string, and opacity goes through `globalAlpha`. */
type Ink = { fg: string; surface: string; alert: string }

function readInk(probe: HTMLElement | null): Ink {
  if (!probe) {
    return { fg: "CanvasText", surface: "Canvas", alert: "CanvasText" }
  }
  const style = getComputedStyle(probe)
  return {
    fg: style.color,
    surface: style.backgroundColor,
    alert: style.borderTopColor,
  }
}

/** The Holi's pixel figure, scaled out of its 16-unit box. */
function drawHoli(
  ctx: CanvasRenderingContext2D,
  sprite: Extract<ArcadeSprite, { kind: "holi" }>
) {
  const layers = pixelLayers(
    sprite.mascot,
    sprite.color,
    sprite.frame === "talk"
  )
  // The 8×8 figure fills 12 of the box's 16 units, centred on the tile.
  const span = sprite.size * PITCH * SPRITE_SCALE
  const unit = span / 12
  const left = sprite.cx * PITCH + CELL / 2 - 8 * unit
  const top = sprite.cy * PITCH + CELL / 2 - 8 * unit
  for (const rect of [...layers.body, ...layers.open]) {
    ctx.fillStyle = rect.fill
    ctx.fillRect(
      left + rect.x * unit,
      top + rect.y * unit,
      rect.w * unit,
      rect.h * unit
    )
  }
}

/** A carried paper, in its Holi's colour: a page with its corner turned, or
 *  a checkbox. */
function drawPaper(
  ctx: CanvasRenderingContext2D,
  sprite: Extract<ArcadeSprite, { kind: "paper" }>
) {
  const side = sprite.size * PITCH
  const px = sprite.cx * PITCH + CELL / 2
  const py = sprite.cy * PITCH + CELL / 2
  ctx.fillStyle = sprite.color
  ctx.strokeStyle = sprite.color
  if (sprite.paper === "task") {
    const s = side * 0.7
    ctx.lineWidth = 2
    ctx.strokeRect(px - s / 2 + 1, py - s / 2 + 1, s - 2, s - 2)
    return
  }
  const w = side * 0.7
  const h = side * 0.9
  const fold = w * 0.35
  const x = px - w / 2
  const y = py - h / 2
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x + w - fold, y)
  ctx.lineTo(x + w, y + fold)
  ctx.lineTo(x + w, y + h)
  ctx.lineTo(x, y + h)
  ctx.closePath()
  ctx.fill()
}

function drawConflict(
  ctx: CanvasRenderingContext2D,
  sprite: Extract<ArcadeSprite, { kind: "conflict" }>,
  fill: string
) {
  const span = sprite.size * PITCH * 0.7
  const unit = span / 5
  const left = sprite.cx * PITCH + CELL / 2 - span / 2
  const top = sprite.cy * PITCH + CELL / 2 - span / 2
  ctx.fillStyle = fill
  CONFLICT_ART.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "#") {
        ctx.fillRect(left + x * unit, top + y * unit, unit, unit)
      }
    }
  })
}

export function HoliArcade({
  cast,
  playing,
  onRelease,
  className,
}: {
  /** The vault's Holis; empty brings the board's default cast. */
  cast: readonly ArcadeCastMember[]
  /** Someone has taken control (`ArcadeTakeControl`): the board covers the
   *  pane at full brightness and takes the keys. */
  playing: boolean
  /** Escape or Release: the only ways out. */
  onRelease: () => void
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const probeRef = useRef<HTMLSpanElement>(null)
  const arcadeRef = useRef<GridArcade | null>(null)
  const playingRef = useRef(false)
  const scoreRef = useRef(0)
  const carryRef = useRef(0)
  /** Wakes the loop from outside the effect (take control, say). */
  const kickRef = useRef<() => void>(() => undefined)
  /** Measures the keep-out again: a game in play has none, since the
   *  board covers the logo then. */
  const refreshRef = useRef<() => void>(() => undefined)
  const [score, setScore] = useState(0)
  const [carrying, setCarrying] = useState(0)
  const [mode, setMode] = useState<ArcadeMode>("mid")
  const modeRef = useRef(mode)
  modeRef.current = mode
  const onReleaseRef = useRef(onRelease)
  onReleaseRef.current = onRelease

  // The cast follows the vault without restarting the loop.
  useEffect(() => {
    arcadeRef.current?.setCast(cast)
  }, [cast])

  /** Hand the board over, or take it back: on the arcade, then wake the
   *  loop. The keep-out goes while a game is on, since it covers the logo. */
  useEffect(() => {
    const arcade = arcadeRef.current
    if (playing === playingRef.current) return
    playingRef.current = playing
    refreshRef.current()
    scoreRef.current = 0
    carryRef.current = 0
    setScore(0)
    setCarrying(0)
    if (playing) {
      arcade?.setMode(modeRef.current)
      arcade?.takeControl()
      rootRef.current?.focus()
    } else {
      arcade?.releaseControl()
    }
    kickRef.current()
  }, [playing])

  const release = useCallback(() => onReleaseRef.current(), [])

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!root || !canvas || !ctx) return

    const arcade = createPaperRun()
    arcade.setCast(cast)
    arcadeRef.current = arcade

    // The cell outlines never move, so they're stroked once here and
    // blitted each frame instead of thousands of strokeRects per paint.
    const gridCanvas = document.createElement("canvas")
    const gridCtx = gridCanvas.getContext("2d")
    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)")

    let raf = 0
    let cols = 0
    let rows = 0
    let width = 0
    let height = 0
    let stamp = new Float32Array(0)
    /** 1 for a cell in the open, `KEEP_DIM` under the logo. */
    let shade = new Float32Array(0)
    let ink = readInk(probeRef.current)
    let lastFrame = 0
    let onScreen = true
    let bubbleAt: { x: number; y: number } | null = null

    const drawGrid = () => {
      if (!gridCtx || width <= 0 || height <= 0) return
      const dpr = window.devicePixelRatio || 1
      gridCanvas.width = Math.floor(width * dpr)
      gridCanvas.height = Math.floor(height * dpr)
      gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      gridCtx.clearRect(0, 0, width, height)
      gridCtx.lineWidth = 1
      gridCtx.strokeStyle = ink.fg
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          // Faded out under the logo, so it keeps its own dots and the
          // board has no hard edge around it.
          const under = shade[y * cols + x] ?? 1
          if (under <= KEEP_DIM) continue
          gridCtx.globalAlpha = BORDER_OPACITY * under
          gridCtx.strokeRect(
            x * PITCH + 0.5,
            y * PITCH + 0.5,
            CELL - 1,
            CELL - 1
          )
        }
      }
      gridCtx.globalAlpha = 1
    }

    /** The cells under what the content marks `data-arcade-keepout`, with
     *  a cell of margin: the board dims there and puts nothing in it. */
    const measureKeepOut = () => {
      const host = root.parentElement
      const box = root.getBoundingClientRect()
      const rects: CellRect[] = []
      shade = new Float32Array(cols * rows).fill(1)
      if (playingRef.current) {
        arcade.setKeepOut(rects)
        return
      }
      host?.querySelectorAll("[data-arcade-keepout]").forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return
        const x0 = Math.max(0, Math.floor((r.left - box.left) / PITCH) - 1)
        const y0 = Math.max(0, Math.floor((r.top - box.top) / PITCH) - 1)
        const x1 = Math.min(cols, Math.ceil((r.right - box.left) / PITCH) + 1)
        const y1 = Math.min(rows, Math.ceil((r.bottom - box.top) / PITCH) + 1)
        if (x1 <= x0 || y1 <= y0) return
        rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
        // Dim inside, easing back to full over `KEEP_FEATHER` cells out.
        const fx0 = Math.max(0, x0 - KEEP_FEATHER)
        const fy0 = Math.max(0, y0 - KEEP_FEATHER)
        const fx1 = Math.min(cols, x1 + KEEP_FEATHER)
        const fy1 = Math.min(rows, y1 + KEEP_FEATHER)
        for (let y = fy0; y < fy1; y++) {
          for (let x = fx0; x < fx1; x++) {
            const out = Math.max(x0 - x, x - (x1 - 1), y0 - y, y - (y1 - 1), 0)
            const t = Math.min(1, out / KEEP_FEATHER)
            const value = KEEP_DIM + (1 - KEEP_DIM) * t * t
            const at = y * cols + x
            shade[at] = Math.min(shade[at] ?? 1, value)
          }
        }
      })
      arcade.setKeepOut(rects)
    }

    const still = () => reducedQuery.matches && !playingRef.current

    // Hidden views collapse to zero size, so the loop parks itself there and
    // the resize observer wakes it once the pane shows again.
    const start = () => {
      if (raf || document.hidden || !onScreen) return
      if (width <= 0 || height <= 0) return
      if (still()) {
        paintStill()
        return
      }
      lastFrame = 0
      raf = requestAnimationFrame(draw)
    }
    kickRef.current = start

    const layout = () => {
      const rect = root.getBoundingClientRect()
      width = rect.width
      height = rect.height
      if (width <= 0 || height <= 0) {
        // Narrowed out of sight mid-game: give the view back.
        if (playingRef.current) onReleaseRef.current()
        return
      }

      const dpr = window.devicePixelRatio || 1
      const nextCols = Math.ceil(width / PITCH)
      const nextRows = Math.ceil(height / PITCH)
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      cols = nextCols
      rows = nextRows
      measureKeepOut()
      arcade.resize(nextCols, nextRows)
      drawGrid()
      start()
    }

    /** Reduced motion and nobody playing: the grid, standing still. */
    const paintStill = () => {
      ctx.clearRect(0, 0, width, height)
      if (gridCanvas.width > 0) ctx.drawImage(gridCanvas, 0, 0, width, height)
    }

    const paint = () => {
      const controlled = arcade.controlled()
      const dim = controlled ? 1 : IDLE_DIM
      if (stamp.length === cols * rows) stamp.fill(0)
      else stamp = new Float32Array(cols * rows)
      arcade.stamp(stamp, cols, rows)

      const fade = arcade.fade()
      ctx.clearRect(0, 0, width, height)

      const peak = PEAK_OPACITY * dim
      ctx.fillStyle = ink.fg
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const at = y * cols + x
          const opacity =
            (stamp[at] ?? 0) * peak * (controlled ? 1 : (shade[at] ?? 1))
          if (opacity > 0.02) {
            ctx.globalAlpha = opacity
            ctx.fillRect(x * PITCH, y * PITCH, CELL, CELL)
          }
        }
      }
      ctx.globalAlpha = 1
      if (fade > 0 && gridCanvas.width > 0) {
        ctx.globalAlpha = fade
        ctx.drawImage(gridCanvas, 0, 0, width, height)
        ctx.globalAlpha = 1
      }

      const spriteDim = controlled ? 1 : IDLE_SPRITE_DIM
      for (const sprite of arcade.sprites()) {
        const cell = Math.round(sprite.cy) * cols + Math.round(sprite.cx)
        const under = controlled ? 1 : (shade[cell] ?? 1)
        const opacity = sprite.alpha * spriteDim * under
        if (opacity <= 0.02) continue
        ctx.globalAlpha = opacity
        if (sprite.kind === "holi") drawHoli(ctx, sprite)
        else if (sprite.kind === "paper") drawPaper(ctx, sprite)
        else drawConflict(ctx, sprite, ink.alert)
      }
      ctx.globalAlpha = 1

      const bubble = arcade.speechBubble()
      if (!bubble) {
        bubbleAt = null
        return
      }

      const target = { x: bubble.x * PITCH, y: bubble.y * PITCH }
      // Ease towards the speaker, but snap when they wrap round the edge
      // so the bubble doesn't sail across the whole canvas to catch up.
      const wrapped =
        bubbleAt &&
        (Math.abs(target.x - bubbleAt.x) > width / 3 ||
          Math.abs(target.y - bubbleAt.y) > height / 3)
      bubbleAt =
        !bubbleAt || wrapped
          ? target
          : {
              x: bubbleAt.x + (target.x - bubbleAt.x) * BUBBLE_EASE,
              y: bubbleAt.y + (target.y - bubbleAt.y) * BUBBLE_EASE,
            }

      drawSpeechBubble(
        ctx,
        bubble.text,
        bubbleAt.x,
        bubbleAt.y,
        CELL,
        { width, height },
        bubble.alpha * (controlled ? BUBBLE_OPACITY : IDLE_BUBBLE_OPACITY),
        { fg: ink.fg, bg: ink.surface, accent: bubble.accent }
      )
    }

    function draw(time: number) {
      if (document.hidden || !onScreen || width <= 0 || height <= 0) {
        raf = 0
        return
      }
      if (still()) {
        raf = 0
        paintStill()
        return
      }
      raf = requestAnimationFrame(draw)
      if (time - lastFrame < FRAME_MS) return
      // A long gap (a parked loop waking) counts as one frame, not a burst.
      const dt = lastFrame ? Math.min(time - lastFrame, 100) : FRAME_MS
      lastFrame = time

      arcade.step(dt)
      paint()

      if (!playingRef.current) return
      const nextScore = arcade.score()
      if (nextScore !== scoreRef.current) {
        scoreRef.current = nextScore
        setScore(nextScore)
      }
      const nextCarry = arcade.carrying()
      if (nextCarry !== carryRef.current) {
        carryRef.current = nextCarry
        setCarrying(nextCarry)
      }
    }

    refreshRef.current = () => {
      if (width <= 0 || height <= 0) return
      measureKeepOut()
      drawGrid()
    }

    const recolour = () => {
      ink = readInk(probeRef.current)
      drawGrid()
      if (still()) paintStill()
    }

    layout()

    document.addEventListener("visibilitychange", start)
    reducedQuery.addEventListener("change", start)
    schemeQuery.addEventListener("change", recolour)

    const resizeObserver = new ResizeObserver(layout)
    resizeObserver.observe(root)
    root.parentElement
      ?.querySelectorAll("[data-arcade-keepout]")
      .forEach((el) => resizeObserver.observe(el))

    // The content scrolls over a board that stays put, so the logo moves.
    const host = root.parentElement
    const onScroll = () => {
      measureKeepOut()
      drawGrid()
      if (still()) paintStill()
    }
    host?.addEventListener("scroll", onScroll, { capture: true, passive: true })

    const visibility = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting)
      start()
    })
    visibility.observe(root)

    // The theme is a class and a `data-theme` on <html>; the glass is a
    // `data-glass`. Any of them can change the tokens.
    const themeObserver = new MutationObserver(recolour)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-glass"],
    })

    return () => {
      cancelAnimationFrame(raf)
      kickRef.current = () => undefined
      refreshRef.current = () => undefined
      document.removeEventListener("visibilitychange", start)
      reducedQuery.removeEventListener("change", start)
      schemeQuery.removeEventListener("change", recolour)
      host?.removeEventListener("scroll", onScroll, { capture: true })
      resizeObserver.disconnect()
      visibility.disconnect()
      themeObserver.disconnect()
      arcadeRef.current = null
    }
    // The cast is handed over by its own effect; this one runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickMode = useCallback((next: ArcadeMode) => {
    arcadeRef.current?.setMode(next)
    setMode(next)
    rootRef.current?.focus()
  }, [])

  // Playing: the board takes the keys while it has the focus. Focus going
  // elsewhere (the sidebar, say) leaves the game running and the keys alone;
  // only Escape or Release ends it.
  useEffect(() => {
    if (!playing) return
    const root = rootRef.current

    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
        return
      }
      const active = document.activeElement
      if (
        active !== root &&
        !(active instanceof Node && root?.contains(active))
      ) {
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        release()
        return
      }
      const heading = HEADING[event.key] ?? HEADING[event.key.toLowerCase()]
      if (!heading) return
      event.preventDefault()
      event.stopPropagation()
      arcadeRef.current?.steer(heading.x, heading.y)
    }

    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [playing, release])

  return (
    <div
      ref={rootRef}
      data-slot="arcade"
      data-playing={playing}
      tabIndex={playing ? 0 : -1}
      role={playing ? "application" : undefined}
      aria-label={
        playing
          ? "Paper run. Arrow keys or WASD to move, Escape to release."
          : undefined
      }
      aria-hidden={playing ? undefined : true}
      className={cn(
        "absolute inset-0 overflow-hidden outline-none",
        playing ? "z-20" : "pointer-events-none",
        className
      )}
    >
      {/* The theme's ink, read by the canvas: foreground, the bubble's
          surface, and the conflicts' colour. */}
      <span
        ref={probeRef}
        aria-hidden="true"
        className="text-foreground bg-popover border-destructive hidden"
      />
      {/* The pane's own ground under a game: opaque on the glass, fading in
          and out with taking control. */}
      <div
        aria-hidden="true"
        className={cn(
          "bg-background absolute inset-0 transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
          playing ? "opacity-100" : "opacity-0"
        )}
      />
      <div className="absolute inset-0" style={playing ? undefined : IDLE_MASK}>
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={cn(
            "absolute inset-0 size-full",
            !playing && "blur-[0.6px]"
          )}
        />
      </div>

      {playing ? (
        // MonoCode's thin row: the score, the speed, the way out.
        <div className="animate-in fade-in-0 absolute inset-x-0 top-0 z-10 grid grid-cols-3 items-center gap-4 px-4 py-3 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]">
          <p className="text-muted-foreground flex gap-3 text-xs tabular-nums">
            <span>
              Score <span className="text-foreground font-medium">{score}</span>
            </span>
            {carrying > 0 ? (
              <span>
                Carrying {carrying}, files for {stackScore(carrying)}
              </span>
            ) : null}
          </p>
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(next) => next && pickMode(next as ArcadeMode)}
            variant="outline"
            spacing={0}
            size="sm"
            aria-label="Speed"
            className="justify-self-center"
          >
            {ARCADE_MODES.map((id) => (
              <ToggleGroupItem key={id} value={id}>
                {MODE_LABEL[id]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button
            variant="outline"
            size="sm"
            onClick={release}
            className="justify-self-end"
          >
            Release
            <Kbd>Esc</Kbd>
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * MonoCode's `[ take control · pac-man ▌ ]`, as a Button: shown while the
 * pointer is over the board's free ground (`show`) or the button has the
 * keyboard's focus, and in the content's flow, so it never sits on a row.
 */
export const ArcadeTakeControl = forwardRef<
  HTMLButtonElement,
  { show: boolean; onClick: () => void; className?: string }
>(function ArcadeTakeControl({ show, onClick, className }, ref) {
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      data-show={show}
      onClick={onClick}
      className={cn(
        "group/take font-mono transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
        "pointer-events-none opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 data-[show=true]:pointer-events-auto data-[show=true]:opacity-100",
        className
      )}
    >
      Take control · Paper run
      {/* The cursor block blinks only where motion is welcome. */}
      <span
        aria-hidden="true"
        className="inline-block h-3 w-1.5 bg-current motion-safe:animate-pulse"
      />
      <Kbd>↵</Kbd>
    </Button>
  )
})
