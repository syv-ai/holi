import { useEffect, useRef } from "react"

import { BRAND_MARK_PATHS } from "@/composites/BrandMark"

/* The "ASCII wake" component from Bencho (bencho.dev/licence, MIT), with one
   shape added: Holi's wordmark beside the original cube. */

/* ══ ASCII wake ═══════════════════════════════════════════
   A cube drawn in ink dots, the dots shrinking toward
   its edge like a halftone. The pointer drags a wake through it:
   right under the hand the characters thicken to their densest
   and stay that way while the hand rests, and
   along the path it came from they thin back out, @ to # to + to
   a dot, as the wake cools. The glyphs lean toward the hand while
   it is near. Press and a ring goes out from the press.

   ── A GRID OF NUMBERS, THEN A RAMP ──────────────────────
   Every cell holds one number. The hand adds to it along the
   line it moved,
   so a fast stroke leaves no gaps; every frame the whole grid
   cools by the same fraction. The number picks a character off
   a ramp of glyphs, lightest to densest. That is the whole
   effect — the same field-then-palette idea as the Heat map,
   with characters where the heat map has colours.

   ── THE SHIMMER ─────────────────────────────────────────
   A cell that is in the wake picks its glyph with a little
   noise, re-dealt every few frames, so the warm part of the wake
   flickers between neighbouring characters the way a terminal
   redraw does. The cold field never flickers. */

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/* lightest to densest; the first is always a blank */
export const RAMPS: Record<string, string[]> = {
  Classic: [" ", ".", ":", "-", "=", "+", "*", "#", "%", "@"],
  Blocks: [" ", "·", "░", "▒", "▓", "█"],
  Dots: [" ", "·", "•", "●"],
  Binary: [" ", ".", ":", "0", "1"],
}

/* ── the shape: a cube, seen corner on ──────────────────────
   A solid, perfectly symmetric shape: three faces of an isometric
   cube make a hexagon, lit from above so each face has its own
   strength — the top brightest, the left in half light, the right
   in shade — with a little gradient across each for depth and a
   crisp line where two faces meet. Returns the dot size directly,
   0 to 1, so the halftone is dense right to the outline.

   The dots are the ink, so which face is dense depends on the page:
   on dark the dots are light and the lit top is the dense one; on
   light they are dark, so it is printed like a halftone — the lit top
   sparse, the shaded side dense. `lit` is the dot size for a face's
   light: the same value, read the right way round for the page. */
const CUBE = 112
/* no face lighter than a third of a full dot: the faintest still
   reads as a face, and is still a field the wake can write on */
const lit = (v: number, dark: boolean) =>
  0.35 + 0.65 * clamp(dark ? v : 1.09 - v, 0, 1)
/* a corner, and a face's two coordinates */
type P = readonly [number, number]
function cube(x: number, y: number, dark: boolean) {
  const R = CUBE
  const c = Math.cos(Math.PI / 6) * R,
    h = R / 2
  /* the corners: top, upper right, bottom, lower left, upper left; the middle is 0,0 */
  const T: P = [0, -R],
    UR: P = [c, -h],
    B: P = [0, R],
    LL: P = [-c, h],
    UL: P = [-c, -h]
  /* where (x, y) sits in a face spanned from o along a and b: s, t in 0..1 when inside */
  const along = (o: P, p: P, q: P): P => {
    const ax = p[0] - o[0],
      ay = p[1] - o[1],
      bx = q[0] - o[0],
      by = q[1] - o[1]
    const dx = x - o[0],
      dy = y - o[1]
    const det = ax * by - ay * bx
    return [(dx * by - dy * bx) / det, (ax * dy - ay * dx) / det]
  }
  const inside = ([s, t]: P) => s >= 0 && s <= 1 && t >= 0 && t <= 1
  /* the seams: a bright line where two faces meet, and the outline */
  const seam = (v: number) => (v < 0.045 ? 1 : 0)
  const top = along(T, UR, UL)
  if (inside(top)) {
    const [s, t] = top
    return seam(1 - s) || seam(1 - t)
      ? 1
      : lit(0.96 - (0.1 * (s + t)) / 2, dark)
  }
  const left = along(UL, [0, 0], LL)
  if (inside(left)) {
    const [s, t] = left
    return seam(s) ? 1 : lit(0.56 - 0.12 * t, dark)
  }
  const right = along([0, 0], UR, B)
  if (inside(right)) {
    const [s, t] = right
    return seam(s) || seam(t) ? 1 : lit(0.13 - 0.05 * s, dark)
  }
  return 0
}

/* ── the other shape: Holi's wordmark ───────────────────────
   The stacked HOLI, filled rather than faced: there are no faces to
   light, so the light falls from above across the whole mark, the
   same `lit` read the same way round for the page. Each cell is
   sampled at nine points, so a cell the outline cuts through gets
   a smaller dot and the letters keep their curves at this
   resolution. The mark sits flush left in its block, so it lines up
   with the column of text under it. */
const MARK_W = 263
const MARK_H = 193
const MARK_PAD = 4
let markPath: Path2D | null = null
let markProbe: CanvasRenderingContext2D | null = null
function mark(
  x: number,
  y: number,
  cw: number,
  ch: number,
  h: number,
  dark: boolean
) {
  /* no canvas to draw with (a test's DOM): no mark */
  if (typeof Path2D === "undefined") return 0
  if (!markPath || !markProbe) {
    markPath = new Path2D()
    for (const d of BRAND_MARK_PATHS) markPath.addPath(new Path2D(d))
    markProbe = document.createElement("canvas").getContext("2d")
  }
  if (!markProbe) return 0
  const k = (h - MARK_PAD * 2) / MARK_H
  const oy = (h - MARK_H * k) / 2
  let hits = 0
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      const px = (x + ((a - 1) * cw) / 3 - MARK_PAD) / k
      const py = (y + ((b - 1) * ch) / 3 - oy) / k
      if (markProbe.isPointInPath(markPath, px, py)) hits++
    }
  }
  if (!hits) return 0
  const down = clamp((y - oy) / (MARK_H * k), 0, 1)
  return lit(0.95 - 0.5 * down, dark) * Math.sqrt(hits / 9)
}

/* each shape's block, px */
const BLOCKS = {
  cube: { w: 360, h: 240 },
  holi: {
    h: 224,
    w: Math.ceil((MARK_W * (224 - MARK_PAD * 2)) / MARK_H) + MARK_PAD * 2,
  },
}

/* the face is the system's own monospace — nothing downloaded */
const MONO = `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`

/* below this much heat a cell is the field: a dot */
const COLD = 0.04
/* how long a press's ring takes to spread and fade, s */
const RING_S = 2.2

/* the press ring and the lean move things across the block, so they
   stay still for someone who asked for less motion; the wake itself
   is only the glyphs changing under the hand, and stays */
const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

/* is the ink light, so the page dark? Read off a pixel the ink is
   painted on, because the theme's colours are oklch() and not three
   numbers a regex can weigh */
function inkIsLight(color: string) {
  const g = document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  })
  if (!g) return false
  g.fillStyle = color
  g.fillRect(0, 0, 1, 1)
  const [r = 0, gr = 0, b = 0] = g.getImageData(0, 0, 1, 1).data
  return r * 0.299 + gr * 0.587 + b * 0.114 > 128
}

export function AsciiWake({
  /* what the dots draw */
  shape = "cube",
  /* the ramp of glyphs */
  glyphs = "Classic",
  /* how big a character is, px */
  size = 10,
  /* how wide the wake is, 0..100 */
  reach = 50,
  /* seconds for the wake to cool */
  trail = 1.2,
  /* how far the glyphs lean toward the hand, 0..100 */
  pull = 40,
  label = "A cube of dots that a pointer drags a wake through",
  className,
}: {
  shape?: keyof typeof BLOCKS
  glyphs?: string
  size?: number
  reach?: number
  trail?: number
  pull?: number
  label?: string
  className?: string
} = {}) {
  const { w: W, h: H } = BLOCKS[shape]
  const cv = useRef<HTMLCanvasElement>(null)
  const knobs = useRef({ glyphs, reach, trail, pull })
  knobs.current = { glyphs, reach, trail, pull }
  const st = useRef({
    cols: 0,
    rows: 0,
    cw: 0,
    ch: 0,
    ox: 0,
    oy: 0,
    font: "",
    /* the wake, one number per cell */
    heat: new Float32Array(0),
    /* how far inside the shape each cell is, 0 outside to 1 */
    mask: new Float32Array(0),
    /* the hand: where it is, where it was last stamped, and how
       present it is (for the lean, which follows it out) */
    hx: -999,
    hy: -999,
    lx: NaN,
    ly: NaN,
    near: 0,
    inside: false,
    /* rings going out from presses */
    rings: [] as { x: number; y: number; t: number }[],
    deal: 0,
    tick: 0,
    raf: 0,
    ratio: 1,
  })

  /* the grid for a character size, cut to the shape */
  const build = () => {
    const s = st.current
    const c = cv.current
    if (!c) return
    const r = Math.min(2, window.devicePixelRatio || 1)
    s.ratio = r
    c.width = Math.round(W * r)
    c.height = Math.round(H * r)
    /* which way round the shading reads: is the ink light (a dark page)? */
    const dark = inkIsLight(getComputedStyle(c).color)
    /* rows a little tighter than the face's own leading, so the
       resting dots sit on an even grid rather than in stripes */
    s.ch = size * 0.82
    s.cw = size * 0.62
    s.cols = Math.floor(W / s.cw - 0.5)
    s.rows = Math.floor(H / s.ch)
    s.font = `500 ${size}px ${MONO}`
    s.heat = new Float32Array(s.cols * s.rows)
    s.mask = new Float32Array(s.cols * s.rows)
    /* the grid centred in the block, whatever is left over split */
    const ox = (s.ox = (W - s.cols * s.cw) / 2),
      oy = (s.oy = (H - s.rows * s.ch) / 2)
    for (let j = 0; j < s.rows; j++) {
      for (let i = 0; i < s.cols; i++) {
        const x = ox + (i + 0.5 + (j & 1) * 0.5) * s.cw,
          y = oy + (j + 0.5) * s.ch
        s.mask[j * s.cols + i] =
          shape === "holi"
            ? mark(x, y, s.cw, s.ch, H, dark)
            : cube(x - W / 2, y - H / 2, dark)
      }
    }
  }

  /* heat dropped on the grid in a soft round at a point */
  const stamp = (x: number, y: number, rad: number, amt: number) => {
    const s = st.current
    x -= s.ox
    y -= s.oy
    const c0 = Math.max(0, Math.floor((x - rad) / s.cw))
    const c1 = Math.min(s.cols - 1, Math.ceil((x + rad) / s.cw))
    const r0 = Math.max(0, Math.floor((y - rad) / s.ch))
    const r1 = Math.min(s.rows - 1, Math.ceil((y + rad) / s.ch))
    const R2 = rad * rad
    for (let j = r0; j <= r1; j++) {
      const dy = (j + 0.5) * s.ch - y
      for (let i = c0; i <= c1; i++) {
        const dx = (i + 0.5) * s.cw - x
        const q = (dx * dx + dy * dy) / R2
        if (q >= 1) continue
        const t = 1 - q
        const k = j * s.cols + i
        s.heat[k] = Math.min(1, s.heat[k]! + amt * t * t)
      }
    }
  }

  /* the wake's width: one cell's worth at 0, a broad swathe at 100 */
  const radius = () => 12 + (clamp(knobs.current.reach, 0, 100) / 100) * 58

  const paint = () => {
    const s = st.current
    const c = cv.current
    if (!c || !s.cols) return
    const g = c.getContext("2d")
    if (!g) return
    g.setTransform(s.ratio, 0, 0, s.ratio, 0, 0)
    g.clearRect(0, 0, W, H)
    /* one ink for everything, the theme's own */
    g.fillStyle = getComputedStyle(c).color
    /* the resting dot: a real circle rather than a full stop, so
       it can be bigger than the face draws one */
    /* a halftone: the dot's AREA follows the density, up to nearly
       touching its neighbours where the shape is fullest */
    const dot = Math.min(s.cw, s.ch) * 0.44
    g.font = s.font
    g.textAlign = "center"
    g.textBaseline = "middle"
    const ramp = RAMPS[knobs.current.glyphs] ?? RAMPS.Classic!
    const top = ramp.length - 1
    /* the lean: up to most of a cell toward the hand, fading with
       distance over twice the wake's width */
    const lean = calm() ? 0 : (clamp(knobs.current.pull, 0, 100) / 100) * s.near
    const rad = radius()
    const far = rad * 2
    const far2 = far * far
    /* the hand's own heat, worked out fresh each frame rather than
       stored, so it never cools: a hand at rest keeps its patch */
    const R2 = rad * rad
    /* the rings, as a band that passes rather than heat that stays:
       a press leaves nothing behind it, only the wave going out */
    const rings = s.rings.map((r) => {
      /* slow and smooth: it eases out as it spreads, a soft wide band
         that fades over its whole life rather than snapping off */
      const p = r.t / RING_S
      const e = 1 - Math.pow(1 - p, 3)
      return {
        x: r.x,
        y: r.y,
        R: 8 + e * 260,
        amp: 0.6 * (1 - p) * (1 - p) * Math.min(1, p * 6),
      }
    })
    for (let j = 0; j < s.rows; j++) {
      const y = s.oy + (j + 0.5) * s.ch
      for (let i = 0; i < s.cols; i++) {
        const k = j * s.cols + i
        const m = s.mask[k]!
        if (m <= 0) continue
        /* odd rows sit half a cell over: a halftone screen */
        const cx = s.ox + (i + 0.5 + (j & 1) * 0.5) * s.cw
        let h = s.heat[k]!
        if (s.near > 0.002) {
          const q = ((cx - s.hx) ** 2 + (y - s.hy) ** 2) / R2
          if (q < 1) h = Math.max(h, 0.95 * s.near * (1 - q) * (1 - q))
        }
        for (const r of rings) {
          /* a wide band, so the ring is a soft swell rather than a line */
          const d = (Math.hypot(cx - r.x, y - r.y) - r.R) / 24
          if (d > -2.5 && d < 2.5) h += r.amp * Math.exp(-d * d)
        }
        /* the faint faces take a little less of the wake, but only a
           little: scaled by the density outright, the lightest face
           never got warm enough to show a glyph at all */
        h *= 0.55 + 0.45 * m
        const v = Math.min(1, h)
        /* the warm part shimmers, the cold field holds still */
        let u = v * top + 0.5
        if (h > COLD) u += (hash(k, s.deal) - 0.5) * 1.6 * Math.min(1, h * 2)
        const idx = clamp(Math.floor(u), 1, top)
        let x = cx
        let yy = y
        if (lean > 0.002) {
          const dx = s.hx - x,
            dy = s.hy - yy
          const d2 = dx * dx + dy * dy
          if (d2 < far2) {
            const f = 1 - d2 / far2
            const d = Math.sqrt(d2) || 1
            /* toward the hand by a share of the gap, never past it */
            const m = Math.min(d * 0.6, 14 * lean * f * f)
            x += (dx / d) * m
            yy += (dy / d) * m
          }
        }
        /* cold, or the lightest step: the dot, smaller toward the
           shape's edge, so the wake fades back into the field
           without a glyph popping in or out */
        if (h <= COLD || idx === 1) {
          g.globalAlpha = 1
          g.beginPath()
          g.arc(x, yy, Math.max(0.45, dot * Math.sqrt(m)), 0, Math.PI * 2)
          g.fill()
          continue
        }
        g.globalAlpha = 1
        g.fillText(ramp[idx]!, x, yy)
      }
    }
    g.globalAlpha = 1
  }

  /* the loop runs only while the wake is warm or the hand is moving */
  const run = () => {
    const s = st.current
    if (s.raf) return
    let prev = performance.now()
    const step = (t: number) => {
      const dt = Math.min(0.05, (t - prev) / 1000)
      prev = t
      /* the cooling: the same fraction off every cell, so a trail
         of seconds T is down to a twentieth after T */
      const keep = Math.exp((-dt * 3) / Math.max(0.1, knobs.current.trail))
      let warm = 0
      for (let k = 0; k < s.heat.length; k++) {
        const h = s.heat[k]! * keep
        s.heat[k] = h < 0.003 ? 0 : h
        if (h > warm) warm = h
      }
      /* the rings run outward for RING_S and are gone */
      s.rings = s.rings.filter((r) => (r.t += dt) < RING_S)
      /* the lean follows the hand in and out */
      s.near += ((s.inside ? 1 : 0) - s.near) * (1 - Math.pow(0.004, dt))
      s.tick += dt
      if (s.tick > 0.07) {
        s.tick = 0
        s.deal++
      }
      paint()
      const still =
        warm === 0 &&
        !s.rings.length &&
        Math.abs((s.inside ? 1 : 0) - s.near) < 0.004
      s.raf = still ? 0 : requestAnimationFrame(step)
    }
    s.raf = requestAnimationFrame(step)
  }

  useEffect(() => {
    build()
    paint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, shape])
  useEffect(() => {
    paint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glyphs])
  useEffect(() => {
    const s = st.current
    return () => {
      cancelAnimationFrame(s.raf)
      s.raf = 0
    }
  }, [])
  useEffect(() => {
    /* a theme flip turns the shading round, so the field is rebuilt;
       Holi's theme is `data-theme`, or the system's when it follows it */
    const flip = () => {
      build()
      paint()
    }
    const mo = new MutationObserver(flip)
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    })
    const system = window.matchMedia("(prefers-color-scheme: dark)")
    system.addEventListener("change", flip)
    return () => {
      mo.disconnect()
      system.removeEventListener("change", flip)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape])

  /* the pointer in the block's own units — the wall zooms cards */
  const where = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    const k = r.width / W
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }

  /* the hand stamps along the whole line since its last frame, a
     stamp every third of a radius, so a flick is one stroke */
  const move = (e: React.PointerEvent) => {
    const s = st.current
    const { x, y } = where(e)
    const rad = radius()
    if (Number.isNaN(s.lx)) {
      s.lx = x
      s.ly = y
    }
    const d = Math.hypot(x - s.lx, y - s.ly)
    const n = Math.max(1, Math.ceil(d / (rad / 3)))
    for (let k = 1; k <= n; k++) {
      const f = k / n
      stamp(s.lx + (x - s.lx) * f, s.ly + (y - s.ly) * f, rad, 0.5)
    }
    s.lx = x
    s.ly = y
    s.hx = x
    s.hy = y
    s.inside = true
    run()
  }

  return (
    <div
      className={className ? `asc ${className}` : "asc"}
      style={{ width: W, height: H }}
      onPointerEnter={(e) => {
        const s = st.current
        s.lx = NaN
        move(e)
      }}
      onPointerMove={move}
      onPointerLeave={() => {
        const s = st.current
        s.inside = false
        s.lx = NaN
        run()
      }}
      onPointerDown={(e) => {
        if (calm()) return
        const { x, y } = where(e)
        st.current.rings.push({ x, y, t: 0 })
        run()
      }}
      role="img"
      aria-label={label}
    >
      <canvas
        ref={cv}
        className="asc-canvas"
        style={{ width: W, height: H }}
        aria-hidden="true"
      />
    </div>
  )
}

/* a stable 0..1 per cell per deal, so the shimmer is noise that
   holds for a few frames rather than flicker every frame */
function hash(k: number, n: number) {
  let h = (k * 374761393 + n * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
