/**
 * The Holis' faces: pixel personas on a 32×32 grid, one parametric sprite
 * dressed per character (hair, skin, top, glasses, beard, height). In the dark
 * theme the same character suits up as a superhero: suit, cape, mask and a 7
 * on the chest.
 *
 * From syv.ai's website personas (syv.ai's own `lib/personas.ts`): the
 * generator and the ten looks are theirs. Here each one is a character, named
 * by `@holi/shared`'s `HOLI_MASCOTS`, not the person it was drawn after. The
 * colours are the figures' own paint, categorical identity, not theme tokens.
 *
 * Pure and browser-safe. Draw at whole multiples of the grid so every pixel
 * stays sharp; a tall character stands `TALL_LIFT` pixels higher, its head
 * above the frame, so whatever draws it lets it out of its box.
 */
import { holiMascotOf, type HoliMascot } from '@holi/shared'

type Hair = 'short' | 'quiff' | 'curly' | 'shaved' | 'fringe' | 'sidepart' | 'swept'
type Top = 'tee' | 'shirt' | 'blazer' | 'jacket' | 'sweater'
type Face = 'stubble' | 'beard' | 'goatee'

/** The superhero a character becomes in the dark. */
type Hero = {
  suit: string
  cape: string
  mask: string
  /** The shield behind the 7. */
  emblem: string
}

type Persona = {
  hair: Hair
  hairColor: string
  skin: string
  top: Top
  topColor: string
  /** Second colour: the tee under a jacket, the shirt under a blazer, a shirt's collar. */
  inner?: string
  glasses?: boolean
  face?: Face
  /** Taller than the rest: stands `TALL_LIFT` pixels higher, head above the frame. */
  tall?: boolean
  hero: Hero
}

/**
 * The grid a persona is drawn on.
 * @public exported for its test
 */
export const PERSONA_GRID = 32

/**
 * How many pixels higher a tall persona stands. Its head draws above the frame.
 * @public exported for its test
 */
export const TALL_LIFT = 5

const GOLD = '#f2c230'

/** @public exported for its test */
export const PERSONAS: Record<HoliMascot, Persona> = {
  captain: {
    hair: 'shaved',
    hairColor: '#9a7a62',
    skin: '#f0c8b0',
    top: 'tee',
    topColor: '#1b1c20',
    glasses: true,
    hero: { suit: '#2456c8', cape: '#c8202f', mask: '#1a3f99', emblem: GOLD },
  },
  strategist: {
    hair: 'shaved',
    hairColor: '#b08a6a',
    skin: '#eebba0',
    top: 'blazer',
    topColor: '#1c2438',
    inner: '#f2f2ef',
    face: 'stubble',
    hero: { suit: '#3a3e48', cape: '#15161a', mask: '#15161a', emblem: GOLD },
  },
  skipper: {
    hair: 'quiff',
    hairColor: '#6b4a30',
    skin: '#e8b597',
    top: 'sweater',
    topColor: '#1f2742',
    face: 'beard',
    hero: { suit: '#d2412c', cape: '#1d6b8f', mask: '#8f2414', emblem: GOLD },
  },
  spy: {
    hair: 'fringe',
    hairColor: '#2b211b',
    skin: '#e6c0a8',
    top: 'tee',
    topColor: '#f0f0ee',
    face: 'goatee',
    hero: { suit: '#6b2bb5', cape: '#1b1b22', mask: '#3f1773', emblem: GOLD },
  },
  professor: {
    hair: 'quiff',
    hairColor: '#c2834f',
    skin: '#eab79b',
    top: 'jacket',
    topColor: '#1d2333',
    inner: '#6b6e70',
    face: 'stubble',
    tall: true,
    hero: { suit: '#1f7a4d', cape: GOLD, mask: '#124a2e', emblem: '#e8e8e4' },
  },
  operator: {
    hair: 'curly',
    hairColor: '#2a1d16',
    skin: '#b98563',
    top: 'shirt',
    topColor: '#2c4a8c',
    inner: '#5a76b0',
    hero: { suit: '#0f8fa3', cape: '#f05a28', mask: '#0a5d6b', emblem: GOLD },
  },
  starter: {
    hair: 'short',
    hairColor: '#3a2a20',
    skin: '#e8b59c',
    top: 'tee',
    topColor: '#4a4c4d',
    hero: { suit: '#e07a24', cape: '#1f2a6b', mask: '#1f2a6b', emblem: '#f4f1e8' },
  },
  scout: {
    hair: 'sidepart',
    hairColor: '#9a6a44',
    skin: '#f0c2a6',
    top: 'shirt',
    topColor: '#f2f2ef',
    inner: '#d6d6d2',
    hero: { suit: '#e9e9e4', cape: '#2456c8', mask: '#2456c8', emblem: '#2456c8' },
  },
  champion: {
    hair: 'swept',
    hairColor: '#c9a46a',
    skin: '#e9b194',
    top: 'tee',
    topColor: '#e8e8e4',
    hero: { suit: GOLD, cape: '#1d1d22', mask: '#1d1d22', emblem: '#1d1d22' },
  },
  benchmarker: {
    hair: 'quiff',
    hairColor: '#8a6a45',
    skin: '#e8b996',
    top: 'shirt',
    topColor: '#1d2a4a',
    inner: '#33426a',
    face: 'stubble',
    tall: true,
    hero: { suit: '#3b3f99', cape: '#e23d6b', mask: '#25285e', emblem: GOLD },
  },
}

/** The character a `mascot` names: a persona's own name, an older arcade
 *  name mapped onto its stand-in, or the strategist for anything else.
 * @public exported for its test
 */
export function personaId(name: string): HoliMascot {
  return holiMascotOf(name) ?? 'strategist'
}

type Pose = 'rest' | 'waveA' | 'waveB'
type Mouth = 'smile' | 'closed' | 'open'
export type Frame = { pose: Pose; mouth: Mouth; blink: boolean }

/*
  Hair as rows of 18 columns (x 7–24) from y = 2. The head spans x 10–21.
  H hair, h highlight, d shadow, K skin, L skin highlight, S shaved shadow.
*/
const HAIR: Record<Hair, string[]> = {
  short: [
    '..................',
    '......HHHHHH......',
    '....HHHHHHHHHH....',
    '...HHHhHHHHhHHH...',
    '...HHHHHHHHHHHH...',
    '...HHdHHHHHHdHH...',
    '...Hd........dH...',
    '...H..........H...',
    '...H..........H...',
  ],
  quiff: [
    '.......HHHH.......',
    '.....HHhhHHH......',
    '....HHHHHhHHHH....',
    '...HHHHHHHHHHHH...',
    '...HHhHHHHHHHHH...',
    '...HHHHHHHHHHHH...',
    '...Hd........dH...',
    '...H..........H...',
  ],
  curly: [
    '.....H.HH.HH.H....',
    '....HdHHdHHdHHd...',
    '...HHHhHHHhHHHhH..',
    '..HdHHHdHHHdHHHdH.',
    '..HHHhHHHhHHHhHHH.',
    '..HHdHHHdHHdHHHdH.',
    '..HHH........HHH..',
    '...Hd........dH...',
    '...H..........H...',
  ],
  shaved: [
    '..................',
    '..................',
    '......SSSSSS......',
    '....SSKKLLKKSS....',
    '...SKKKKKKKKKKS...',
    '...S..........S...',
  ],
  fringe: [
    '..................',
    '.....HHHHHHHH.....',
    '....HHHhHHHHHH....',
    '...HHHHHHHHhHHH...',
    '..HHHHHHHHHHHHHH..',
    '..HHHHHHHHHHHHHH..',
    '..HHHdHHHdHHHdHH..',
    '..HHH.HH..H..HHH..',
    '..HH..........HH..',
    '..HH..........HH..',
    '..HH..........HH..',
    '..Hd..........dH..',
    '..d............d..',
  ],
  sidepart: [
    '..................',
    '......HHHHHHH.....',
    '....HHHHHHHhHHH...',
    '...HHHHHHHHHhHHH..',
    '...HHhHHHHHdHHHH..',
    '...HHHHHHHHd.HHH..',
    '...HHHHHH....dHH..',
    '...Hd.........H...',
    '...H..........H...',
  ],
  swept: [
    '.......HHHH.......',
    '.....HHHHhHHH.....',
    '...HHHHhHHHHHHH...',
    '..HHHHHHHHhHHHHH..',
    '..HHhHHHHHHHHHHH..',
    '..HHHHHHd...HHHH..',
    '..HHHHd......dHH..',
    '..HHH.........HH..',
    '..HH..........HH..',
    '..Hd..........dH..',
    '...d..........d...',
  ],
}

/** Shift a #rrggbb colour toward black (k < 0) or white (k > 0). */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k),
  )
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const ch = [16, 8, 0].map((s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t))
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
}

/** A light and a dark edge for a cloth colour, so dark clothes still read on a dark ground. */
function edges(hex: string): { hi: string; lo: string } {
  const light = lum(hex) > 140
  return {
    hi: light ? shade(hex, 0.5) : shade(hex, 0.3),
    lo: light ? shade(hex, -0.16) : shade(hex, -0.35),
  }
}

/** A horizontal run of same-coloured pixels. */
export type Run = { x: number; y: number; w: number; fill: string }

/**
 * Compose one frame into horizontal runs of same-coloured pixels, top to bottom.
 * @public exported for its test
 */
export function drawPersona(p: Persona, f: Frame, heroMode = false): Run[] {
  const px = new Map<number, string>()
  // A pixel's key: rows run from -TALL_LIFT, so offset them to stay positive.
  const key = (x: number, y: number): number => (y + 8) * 64 + x
  const set = (x: number, y: number, c: string): void => {
    px.set(key(x, y), c)
  }
  const rect = (x0: number, y0: number, x1: number, y1: number, c: string): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c)
  }
  const dots = (cells: readonly (readonly [number, number])[], c: string, dx = 0): void => {
    for (const [x, y] of cells) set(x + dx, y, c)
  }
  const h = p.hero
  const skin = p.skin
  const skinS = shade(skin, -0.14)
  const skinD = shade(skin, -0.26)
  const skinL = shade(skin, 0.25)
  const top = heroMode ? h.suit : p.topColor
  const { hi: topH, lo: topS } = edges(top)
  const inner = p.inner ?? topS
  const hair = p.hairColor
  const hairH = shade(hair, 0.25)
  const hairD = shade(hair, -0.3)
  const ink = '#16171a'
  const hand = heroMode ? shade(h.suit, -0.2) : skin

  // The cape hangs behind everything, with a standing collar behind the neck.
  if (heroMode) {
    const capeS = shade(h.cape, -0.3)
    rect(2, 22, 29, 31, h.cape)
    rect(2, 22, 3, 31, capeS)
    rect(28, 22, 29, 31, capeS)
    rect(8, 18, 9, 21, h.cape)
    rect(22, 18, 23, 21, capeS)
    rect(7, 20, 24, 21, h.cape)
  }

  // Torso and arms, lit from the left.
  rect(10, 21, 21, 21, top)
  rect(8, 22, 23, 22, top)
  rect(7, 23, 24, 31, top)
  rect(24, 23, 24, 31, topS)
  rect(4, 24, 6, 31, top)
  rect(4, 24, 4, 31, topH)
  rect(6, 25, 6, 31, topS)
  if (f.pose === 'rest') {
    rect(25, 24, 27, 31, top)
    rect(25, 25, 25, 31, topS)
    rect(27, 24, 27, 31, topS)
  }

  // Neckline and front.
  if (heroMode) {
    rect(13, 21, 18, 21, topS)
    // The shield with the 7.
    rect(13, 24, 18, 26, h.emblem)
    rect(14, 27, 17, 27, h.emblem)
    rect(15, 28, 16, 28, h.emblem)
    rect(14, 25, 17, 25, h.suit)
    set(17, 26, h.suit)
    set(16, 27, h.suit)
    set(15, 28, h.suit)
  } else if (p.top === 'tee' || p.top === 'sweater') {
    rect(13, 21, 18, 21, skin)
    rect(14, 22, 17, 22, skin)
    set(12, 21, topS)
    set(19, 21, topS)
    set(13, 22, topS)
    set(18, 22, topS)
    rect(14, 23, 17, 23, topS)
    if (p.top === 'sweater') {
      rect(13, 23, 18, 23, topS)
      rect(7, 30, 24, 30, topS)
    }
  } else if (p.top === 'shirt') {
    rect(14, 21, 17, 21, skin)
    rect(15, 22, 16, 23, skin)
    rect(12, 21, 13, 21, inner)
    rect(18, 21, 19, 21, inner)
    rect(13, 22, 14, 22, inner)
    rect(17, 22, 18, 22, inner)
    rect(16, 24, 16, 31, topS)
    set(15, 25, inner)
    set(15, 28, inner)
    set(15, 31, inner)
  } else {
    // Blazer or jacket open over a shirt or tee.
    rect(12, 21, 19, 31, inner)
    rect(14, 21, 17, 21, skin)
    rect(15, 22, 16, 22, skin)
    const lapel = p.top === 'blazer' ? topS : shade(top, 0.15)
    dots(
      [
        [12, 22],
        [12, 23],
        [13, 24],
        [13, 25],
        [13, 26],
        [12, 27],
      ],
      lapel,
    )
    dots(
      [
        [19, 22],
        [19, 23],
        [18, 24],
        [18, 25],
        [18, 26],
        [19, 27],
      ],
      lapel,
    )
    rect(11, 22, 11, 31, top)
    rect(20, 22, 20, 31, top)
    if (p.top === 'jacket') {
      rect(12, 21, 13, 21, shade(inner, -0.2))
      rect(18, 21, 19, 21, shade(inner, -0.2))
    } else {
      set(15, 29, shade(top, -0.4))
    }
  }

  // The waving arm, two frames.
  if (f.pose !== 'rest') {
    const b = f.pose === 'waveB' ? 1 : 0
    rect(24, 22, 26, 24, top)
    rect(25, 20, 27, 21, top)
    rect(25 + b, 18, 27 + b, 19, top)
    rect(25, 20, 25, 21, topH)
    rect(25 + b, 18, 25 + b, 19, topH)
    rect(25 + b, 14, 28 + b, 17, hand)
    dots(
      [
        [25, 13],
        [26, 12],
        [26, 13],
        [27, 12],
        [27, 13],
        [28, 13],
      ],
      hand,
      b,
    )
    set(24 + b, 15, hand)
    set(24 + b, 16, hand)
    rect(28 + b, 14, 28 + b, 17, heroMode ? shade(hand, -0.2) : skinS)
  }

  // Neck.
  rect(13, 19, 18, 20, skin)
  rect(13, 19, 18, 19, skinD)
  rect(18, 20, 18, 20, skinS)

  // Head, rounded, lit from the left.
  rect(11, 6, 20, 6, skin)
  rect(10, 7, 21, 16, skin)
  rect(11, 17, 20, 17, skin)
  rect(12, 18, 19, 18, skin)
  rect(21, 8, 21, 16, skinS)
  rect(20, 17, 20, 17, skinS)
  rect(18, 18, 19, 18, skinS)
  rect(11, 8, 11, 10, skinL)
  // Ears.
  rect(9, 11, 9, 13, skin)
  set(9, 12, skinS)
  rect(22, 11, 22, 13, skinS)
  set(22, 12, skinD)

  // Facial hair.
  if (p.face) {
    const c = p.face === 'beard' ? hair : mix(skin, hair, 0.38)
    if (p.face === 'goatee') {
      rect(14, 18, 17, 18, c)
      set(13, 17, c)
      set(18, 17, c)
    } else {
      dots(
        [
          [11, 15],
          [20, 15],
          [11, 16],
          [12, 16],
          [19, 16],
          [20, 16],
          [11, 17],
          [12, 17],
          [13, 17],
          [18, 17],
          [19, 17],
          [20, 17],
        ],
        c,
      )
      rect(12, 18, 19, 18, c)
      if (p.face === 'beard') {
        rect(10, 13, 10, 16, c)
        rect(21, 13, 21, 16, shade(c, -0.15))
        rect(13, 15, 18, 15, c)
        rect(14, 17, 17, 17, c)
        rect(13, 18, 18, 18, shade(c, -0.15))
      }
    }
  }

  // Brows, eyes, nose, mouth.
  const brow = p.hair === 'shaved' ? shade(p.hairColor, -0.25) : hairD
  const browY = p.glasses && !heroMode ? 10 : 11
  rect(12, browY, 14, browY, brow)
  rect(17, browY, 19, browY, brow)
  if (heroMode) {
    // Domino mask over the eyes.
    rect(11, 11, 20, 13, h.mask)
    rect(11, 14, 14, 14, h.mask)
    rect(17, 14, 20, 14, h.mask)
    set(10, 12, h.mask)
    set(21, 12, h.mask)
  }
  if (f.blink) {
    rect(12, 13, 13, 13, heroMode ? shade(h.mask, -0.3) : skinD)
    rect(18, 13, 19, 13, heroMode ? shade(h.mask, -0.3) : skinD)
  } else {
    rect(12, 12, 12, 13, '#f4f1ea')
    rect(13, 12, 13, 13, ink)
    rect(18, 12, 18, 13, ink)
    rect(19, 12, 19, 13, '#f4f1ea')
  }
  set(16, 14, skinS)
  rect(15, 15, 16, 15, skinS)
  const lip = shade(skin, -0.4)
  if (f.mouth === 'smile') {
    set(13, 16, lip)
    set(18, 16, lip)
    rect(14, 17, 17, 17, lip)
  } else if (f.mouth === 'open') {
    rect(14, 16, 17, 16, '#f4f1ea')
    rect(14, 17, 17, 17, '#4a1f1a')
  } else {
    rect(14, 17, 17, 17, lip)
  }

  if (p.glasses && !heroMode) {
    const g = '#2a2b2f'
    rect(11, 11, 14, 11, g)
    rect(11, 14, 14, 14, g)
    rect(11, 12, 11, 13, g)
    rect(14, 12, 14, 13, g)
    rect(17, 11, 20, 11, g)
    rect(17, 14, 20, 14, g)
    rect(17, 12, 17, 13, g)
    rect(20, 12, 20, 13, g)
    rect(15, 12, 16, 12, g)
    set(10, 12, g)
    set(21, 12, g)
  }

  // Hair over the head.
  const paint: Record<string, string> = {
    H: hair,
    h: hairH,
    d: hairD,
    K: skin,
    L: skinL,
    S: mix(skin, hair, 0.3),
  }
  HAIR[p.hair].forEach((row, i) => {
    for (let j = 0; j < row.length; j++) {
      const c = paint[row[j]!]
      if (c) set(7 + j, 2 + i, c)
    }
  })

  // Tall: the whole figure stands TALL_LIFT pixels higher, shoulders and all,
  // and the torso runs on below to the frame's edge. The head rises above the
  // frame (negative rows).
  let out = px
  let firstRow = 0
  if (p.tall) {
    out = new Map()
    firstRow = -TALL_LIFT
    for (const [k, c] of px) out.set(k - TALL_LIFT * 64, c)
    for (let y = PERSONA_GRID - TALL_LIFT; y < PERSONA_GRID; y++) {
      for (let x = 0; x < PERSONA_GRID; x++) {
        const c = px.get(key(x, PERSONA_GRID - 1))
        if (c) out.set(key(x, y), c)
      }
    }
  }

  // Merge into runs.
  const runs: Run[] = []
  for (let y = firstRow; y < PERSONA_GRID; y++) {
    let x = 0
    while (x < PERSONA_GRID) {
      const c = out.get(key(x, y))
      if (!c) {
        x++
        continue
      }
      let w = 1
      while (out.get(key(x + w, y)) === c) w++
      runs.push({ x, y, w, fill: c })
      x += w
    }
  }
  return runs
}

/**
 * The head-and-shoulders window the small slots show: 20 pixels square, from
 * the top of the hair to the line of the shoulders, the head centred. A tall
 * character is drawn at everyone's height here, so heads line up in a list.
 * @public exported for its test
 */
export const HEAD_CROP = { x: 6, y: 2, size: 20 } as const

/** How a persona is framed: the whole figure (32 wide, `TALL_LIFT` of
 *  headroom above the 32 rows), or the head-and-shoulders window. */
export type PersonaCrop = 'full' | 'head'

/** The box a crop occupies, in sprite pixels. */
export function cropBox(crop: PersonaCrop): { x: number; y: number; w: number; h: number } {
  return crop === 'head'
    ? { x: HEAD_CROP.x, y: HEAD_CROP.y, w: HEAD_CROP.size, h: HEAD_CROP.size }
    : { x: 0, y: -TALL_LIFT, w: PERSONA_GRID, h: PERSONA_GRID + TALL_LIFT }
}

const cache = new Map<string, readonly Run[]>()

/**
 * A character's frame as runs, cut to its crop: memoised, since a list of
 * Holis draws the same few frames over and over.
 */
export function personaRuns(
  name: string,
  frame: Frame,
  heroMode: boolean,
  crop: PersonaCrop = 'full',
): readonly Run[] {
  const id = personaId(name)
  const k = `${id}|${frame.pose}|${frame.mouth}|${frame.blink ? 1 : 0}|${heroMode ? 1 : 0}|${crop}`
  const hit = cache.get(k)
  if (hit) return hit
  const p = PERSONAS[id]
  let runs: readonly Run[]
  if (crop === 'full') {
    runs = drawPersona(p, frame, heroMode)
  } else {
    const { x, y, w, h } = cropBox(crop)
    runs = drawPersona({ ...p, tall: false }, frame, heroMode).flatMap((r) => {
      const x0 = Math.max(r.x, x)
      const x1 = Math.min(r.x + r.w, x + w)
      return r.y >= y && r.y < y + h && x1 > x0 ? [{ ...r, x: x0, w: x1 - x0 }] : []
    })
  }
  cache.set(k, runs)
  return runs
}
