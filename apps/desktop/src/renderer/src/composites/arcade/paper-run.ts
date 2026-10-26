/**
 * Paper run: the vault's Holis at work on the empty view's grid.
 *
 * Written for Holi on MonoCode's grid-arcade model
 * (https://github.com/hardbeat920/monocode), MIT License, Copyright (c) 2026
 * Nick; see license in this folder. The two grids, the tile lattice the movers
 * walk with a fractional `progress`, the boot fade, the greedy idle brain, the
 * buffered steering and the speech timing follow MonoCode's snake and pac-man
 * (`snakeArcade.ts`, `pacmanArcade.ts`); the game itself is Holi's.
 *
 * Papers, documents and tasks, land on the board. A Holi picks them up, carries
 * them as a stack that trails behind it, and files them in the outbox. Merge
 * conflicts wander about, and walking into one scatters the stack. Filing more
 * at once scores more (1 + 2 + … + n), so a player weighs a bigger stack
 * against the conflicts. Idle, every Holi plays itself; taken over, the player
 * steers the first of the cast and the rest are rivals for the same papers.
 *
 * Everything lives on two grids, as in MonoCode's pac-man. The background grid
 * is one cell per square, which is what `stamp` paints the papers and the
 * outbox into. On top sits the lattice of `TILE`-cell tiles the movers walk on;
 * `sprites` hands their positions back in fractional cells so the caller can
 * draw them mid-step.
 *
 * Random on purpose (`Math.random`): where papers land, and how the idle brain
 * breaks a tie.
 */
import { HOLI_COLOURS, holiMascotOf, type HoliMascot } from '@holi/shared'

import type {
  ArcadeCastMember,
  ArcadeMode,
  ArcadeSprite,
  CellRect,
  GridArcade,
  PaperKind,
  SpeechBubble,
} from './grid-arcade'

const BOOT_FADE_MS = 420

/**
 * Cells to a tile: a Holi gets a 4×4 square of the grid.
 * @public exported for its test
 */
export const TILE = 4

/** Smallest board worth running; below this the surface stays a plain grid. */
const MIN_TILE_COLS = 8
const MIN_TILE_ROWS = 5

/** ms per tile for the Holis, idle and at each of the player's speeds. */
const IDLE_TICK = 230
const MODE_TICK: Record<ArcadeMode, number> = { low: 200, mid: 150, hard: 110 }
/** The rivals keep an idle pace while you play, so you can outrun them. */
const RIVAL_TICK = 240
/** Conflicts dawdle: this many Holi steps to one of theirs. */
const CONFLICT_SLOW = 2.2

/** How long a Holi stands dazed after walking into a conflict. */
const STUN_MS = 900
const STUN_BLINK_MS = 120

/** A new paper every so often, until the board holds its share. */
const PAPER_GAP_MS = 1300
const PLAYER_PAPER_GAP_MS = 850
const PAPER_FADE_MS = 400
const TASK_SHARE = 0.35

/** What an idle Holi carries before it heads for the outbox. */
const IDLE_CAPACITY = [3, 4, 3, 5, 4] as const
/** The player's stack can grow until the trail would wrap the board. */
const PLAYER_CAPACITY = 12

/**
 * The cast on the board at once; a vault with more brings its first few.
 * @public exported for its test
 */
export const MAX_CAST = 5

/** The outbox is two tiles to a side. */
const OUTBOX_TILES = 2
const OUTBOX_FLASH_MS = 600

/** Conflicts on the board: one idle, and one more every so many points. */
const CONFLICT_EVERY = 30
const MAX_CONFLICTS = 4

const SPEECH_FADE_MS = 260
/** How long a line stays up after whoever said it opened their mouth. */
const SPEECH_HOLD_MS = 2200
/** How long a Holi's mouth keeps moving after it speaks. */
const TALK_MS = 700

/** Brightness of the stamped pieces, before the renderer's own dimming. */
const PAPER_VALUE = 0.85
const PAPER_SOFT = 0.5
const OUTBOX_VALUE = 0.55

/**
 * The papers and the outbox, traced on the grid: `#` lit, `+` half lit. A
 * document is a page with its corner turned; a task is an open checkbox.
 */
const GLYPHS: Record<PaperKind | 'outbox', readonly string[]> = {
  doc: ['##+.', '#+#.', '#+#.', '###.'],
  task: ['###.', '#.#.', '###.', '....'],
  outbox: [
    '...##...',
    '...##...',
    '.######.',
    '..####..',
    '#..##..#',
    '#......#',
    '########',
    '........',
  ],
}

/** What any Holi says when it files a stack. */
const FILED_LINES = [
  'FILED!',
  'INBOX ZERO',
  'DONE AND DUSTED',
  'DIGEST READY',
  'PROPOSAL SENT',
  'ALL CHECKED OFF',
  'ON YOUR DESK',
  "THAT'S A WRAP",
  'COMMITTED',
  'SIGNED AND SENT',
  'NOTES IN ORDER',
]

/** A stack of four or more. */
const STACK_LINES = ['A WHOLE STACK!', 'WORK OF THE WEEK', 'BATCH FILED', 'ALL OF IT, DONE']

/** Each figure's own way of putting it. */
const VOICE: Record<HoliMascot, readonly string[]> = {
  captain: ['CAPTAIN ON DECK', 'FILED. CASE CLOSED'],
  strategist: ['ALL ACCORDING TO PLAN', 'A STRATEGIC FILING'],
  skipper: ['FULL STEAM TO OUTBOX', 'ALL HANDS, FILED'],
  spy: ['MISSION COMPLETE', 'FILED. TOP SECRET'],
  professor: ['CLASS DISMISSED', 'TEXTBOOK FILING'],
  operator: ['SHIPPED TO PROD', 'RUNNING IN PRODUCTION'],
  starter: ['OFF TO A FLYING START', "AND WE'RE OFF"],
  scout: ['FRESH FROM THE FIELD', 'REPORTING BACK'],
  champion: ['GOLD MEDAL FILING', 'UNDEFEATED'],
  benchmarker: ['NEW HIGH SCORE', 'TOP OF THE BENCHMARK'],
}

/** The Holi that just walked into a conflict. */
const CONFLICT_LINES = [
  'MERGE CONFLICT!',
  'WHO EDITED THIS?',
  'OURS OR THEIRS?',
  'REBASING…',
  'SHOULD HAVE PULLED',
]

/**
 * Who plays when the vault has no Holis, or the holis plugin is off.
 * @public exported for its test
 */
export const DEFAULT_CAST: readonly ArcadeCastMember[] = [
  { id: 'captain', name: 'Captain', mascot: 'captain', color: HOLI_COLOURS[0] },
  {
    id: 'professor',
    name: 'Professor',
    mascot: 'professor',
    color: HOLI_COLOURS[1],
  },
  {
    id: 'operator',
    name: 'Operator',
    mascot: 'operator',
    color: HOLI_COLOURS[2],
  },
]

const DIRS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
] as const

type Tile = { x: number; y: number }

type Mover = {
  tx: number
  ty: number
  dx: number
  dy: number
  /** 0 → 1 across the step from this tile to the next. */
  progress: number
}

type Holi = Mover & {
  member: ArcadeCastMember
  /** The stack it carries, oldest first. */
  carry: PaperKind[]
  /** Tiles it has just left, newest first: where the stack rides. */
  trail: Tile[]
  cap: number
  stun: number
  talk: number
  /** Tiles walked, for the two-frame walk. */
  steps: number
  /** The paper it is after, so two Holis don't chase the same one. */
  goal: number | null
  /** Somewhere to stroll to when there is nothing to do. */
  wander: Tile | null
}

type Paper = { id: number; x: number; y: number; kind: PaperKind; age: number }

type Speech = { text: string; age: number; from: string }

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

/** The board's stack score: filing n papers at once is worth 1 + 2 + … + n. */
export function stackScore(count: number): number {
  return (count * (count + 1)) / 2
}

export function createPaperRun(): GridArcade {
  let cols = 0
  let rows = 0
  let tileCols = 0
  let tileRows = 0
  /** Cell offset of the lattice's top-left corner, keeping it centred. */
  let originX = 0
  let originY = 0
  let ready = false

  let keepOut: readonly CellRect[] = []
  /** 1 where a tile overlaps the keep-out: nothing is put there. */
  let kept = new Uint8Array(0)

  let cast: readonly ArcadeCastMember[] = DEFAULT_CAST
  let holis: Holi[] = []
  let papers: Paper[] = []
  let nextPaperId = 1
  let paperTimer = 0
  let conflicts: Mover[] = []
  let outbox: Tile = { x: 0, y: 0 }
  let outboxFlash = 0

  let speech: Speech | null = null
  let lastLine = ''

  let booted = 0
  let player = false
  let pending: Tile | null = null
  let score = 0
  let mode: ArcadeMode = 'mid'

  const wrapX = (x: number) => (tileCols ? ((x % tileCols) + tileCols) % tileCols : 0)
  const wrapY = (y: number) => (tileRows ? ((y % tileRows) + tileRows) % tileRows : 0)

  /** Shortest signed run from a to b on a board that wraps. */
  const span = (a: number, b: number, size: number) => {
    const direct = b - a
    if (!size) return direct
    const around = direct - Math.sign(direct) * size
    return Math.abs(direct) <= Math.abs(around) ? direct : around
  }

  const distance = (a: Tile, b: Tile) =>
    Math.abs(span(a.x, b.x, tileCols)) + Math.abs(span(a.y, b.y, tileRows))

  const cellX = (tx: number) => originX + tx * TILE
  const cellY = (ty: number) => originY + ty * TILE

  /** Where a mover actually is, in fractional tiles. */
  const atX = (m: Mover) => m.tx + m.dx * m.progress
  const atY = (m: Mover) => m.ty + m.dy * m.progress

  const isKept = (x: number, y: number) => kept[y * tileCols + x] === 1

  const onOutbox = (x: number, y: number) =>
    span(outbox.x, x, tileCols) >= 0 &&
    span(outbox.x, x, tileCols) < OUTBOX_TILES &&
    span(outbox.y, y, tileRows) >= 0 &&
    span(outbox.y, y, tileRows) < OUTBOX_TILES

  const paperAt = (x: number, y: number) => papers.find((paper) => paper.x === x && paper.y === y)

  /** Never the same line twice running, whoever says it. A line already up
   *  keeps the floor unless `force` (the player's own). */
  const say = (lines: readonly string[], from: string, force = false) => {
    if (speech && !force && speech.age < SPEECH_HOLD_MS) return
    let text = lastLine
    while (text === lastLine && lines.length > 1) text = pick(lines)
    if (lines.length === 1) text = lines[0]!
    lastLine = text
    speech = { text, age: 0, from }
    const speaker = holis.find((holi) => holi.member.id === from)
    if (speaker) speaker.talk = TALK_MS
  }

  const speechAlpha = (state: Speech) => {
    const fadeIn = Math.min(1, state.age / SPEECH_FADE_MS)
    const fadeOut = Math.max(0, 1 - (state.age - SPEECH_HOLD_MS) / SPEECH_FADE_MS)
    return Math.min(fadeIn, fadeOut)
  }

  /** A free tile: not kept clear, not the outbox, not under a paper, and not
   *  next to a Holi unless it is looking `near` one spot. */
  const freeTile = (near?: Tile, radius = 0): Tile | null => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const x = near
        ? wrapX(near.x + Math.round((Math.random() * 2 - 1) * radius))
        : Math.floor(Math.random() * tileCols)
      const y = near
        ? wrapY(near.y + Math.round((Math.random() * 2 - 1) * radius))
        : Math.floor(Math.random() * tileRows)
      if (isKept(x, y) || onOutbox(x, y) || paperAt(x, y)) continue
      if (!near && holis.some((holi) => distance({ x, y }, { x: holi.tx, y: holi.ty }) < 2))
        continue
      return { x, y }
    }
    return null
  }

  const paperCap = () => clamp(Math.floor((tileCols * tileRows) / 40), 4, 16) + (player ? 2 : 0)

  const spawnPaper = () => {
    if (papers.length >= paperCap()) return
    const spot = freeTile()
    if (!spot) return
    papers.push({
      id: nextPaperId++,
      ...spot,
      kind: Math.random() < TASK_SHARE ? 'task' : 'doc',
      age: 0,
    })
  }

  const placeOutbox = () => {
    const fits = (x: number, y: number) => {
      for (let dy = 0; dy < OUTBOX_TILES; dy++) {
        for (let dx = 0; dx < OUTBOX_TILES; dx++) {
          if (isKept(x + dx, y + dy)) return false
        }
      }
      return true
    }
    const maxX = tileCols - OUTBOX_TILES - 1
    const maxY = tileRows - OUTBOX_TILES - 1
    for (let attempt = 0; attempt < 80; attempt++) {
      const x = 1 + Math.floor(Math.random() * Math.max(1, maxX))
      const y = 1 + Math.floor(Math.random() * Math.max(1, maxY))
      if (fits(x, y)) {
        outbox = { x, y }
        return
      }
    }
    outbox = { x: Math.max(0, maxX), y: Math.max(0, maxY) }
  }

  const makeHoli = (member: ArcadeCastMember, index: number): Holi => {
    const spot = freeTile() ?? { x: index % tileCols, y: 0 }
    return {
      member,
      tx: spot.x,
      ty: spot.y,
      dx: 0,
      dy: 0,
      progress: 0,
      carry: [],
      trail: [],
      cap: IDLE_CAPACITY[index % IDLE_CAPACITY.length]!,
      stun: 0,
      talk: 0,
      steps: 0,
      goal: null,
      wander: null,
    }
  }

  const placeHolis = () => {
    const members = (cast.length ? cast : DEFAULT_CAST).slice(0, MAX_CAST)
    const kept = holis
    holis = []
    members.forEach((member, index) => {
      const old = kept.find((holi) => holi.member.id === member.id)
      holis.push(old ? { ...old, member } : makeHoli(member, index))
    })
  }

  const conflictCount = () =>
    player ? Math.min(MAX_CONFLICTS, 1 + Math.floor(score / CONFLICT_EVERY)) : 1

  /** A conflict, somewhere well away from every Holi. */
  const spawnConflict = (): Mover => {
    let best: Tile = { x: 0, y: 0 }
    let bestReach = -1
    for (let attempt = 0; attempt < 20; attempt++) {
      const spot = freeTile()
      if (!spot) continue
      const reach = Math.min(...holis.map((holi) => distance(spot, { x: holi.tx, y: holi.ty })), 99)
      if (reach > bestReach) {
        best = spot
        bestReach = reach
      }
    }
    const dir = pick(DIRS)
    return { tx: best.x, ty: best.y, dx: dir.x, dy: dir.y, progress: 0 }
  }

  const rebuild = () => {
    tileCols = Math.floor(cols / TILE)
    tileRows = Math.floor(rows / TILE)
    if (tileCols < MIN_TILE_COLS || tileRows < MIN_TILE_ROWS) {
      ready = false
      holis = []
      papers = []
      conflicts = []
      speech = null
      return
    }
    ready = true
    originX = Math.floor((cols - tileCols * TILE) / 2)
    originY = Math.floor((rows - tileRows * TILE) / 2)
    markKeepOut()
    placeOutbox()
    papers = []
    holis = []
    placeHolis()
    conflicts = []
    for (let i = 0; i < conflictCount(); i++) conflicts.push(spawnConflict())
    // A few to start on, so the board is busy from the first frame.
    for (let i = 0; i < 4; i++) spawnPaper()
    paperTimer = PAPER_GAP_MS
    speech = null
    pending = null
  }

  const markKeepOut = () => {
    kept = new Uint8Array(tileCols * tileRows)
    for (const rect of keepOut) {
      const x0 = Math.floor((rect.x - originX) / TILE)
      const y0 = Math.floor((rect.y - originY) / TILE)
      const x1 = Math.floor((rect.x + rect.w - 1 - originX) / TILE)
      const y1 = Math.floor((rect.y + rect.h - 1 - originY) / TILE)
      for (let y = Math.max(0, y0); y <= Math.min(tileRows - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(tileCols - 1, x1); x++) {
          kept[y * tileCols + x] = 1
        }
      }
    }
  }

  const boot = () => {
    booted = 0
    score = 0
    rebuild()
  }

  /** Turn on the spot, keeping the sprite where it already is. */
  const reverse = (m: Mover) => {
    if (!m.dx && !m.dy) return
    if (m.progress > 0) {
      m.tx = wrapX(m.tx + m.dx)
      m.ty = wrapY(m.ty + m.dy)
      m.progress = 1 - m.progress
    }
    m.dx = -m.dx
    m.dy = -m.dy
  }

  const danger = (x: number, y: number) =>
    conflicts.some(
      (c) =>
        distance({ x, y }, { x: wrapX(Math.round(atX(c))), y: wrapY(Math.round(atY(c))) }) <= 1,
    )

  /**
   * The idle brain. A full stack goes to the outbox; otherwise the nearest
   * paper nobody else is after, then the outbox with whatever it has, then a
   * stroll. Tiles next to a conflict count as far worse than a detour.
   */
  const think = (holi: Holi) => {
    const here = { x: holi.tx, y: holi.ty }
    const nearestOutbox = () => {
      let best = outbox
      let bestDistance = Infinity
      for (let dy = 0; dy < OUTBOX_TILES; dy++) {
        for (let dx = 0; dx < OUTBOX_TILES; dx++) {
          const tile = { x: wrapX(outbox.x + dx), y: wrapY(outbox.y + dy) }
          const d = distance(here, tile)
          if (d < bestDistance) {
            best = tile
            bestDistance = d
          }
        }
      }
      return best
    }

    let target: Tile | null = null
    holi.goal = null
    if (holi.carry.length >= holi.cap) {
      target = nearestOutbox()
    } else {
      const claimed = new Set(holis.filter((other) => other !== holi).map((other) => other.goal))
      let best: Paper | null = null
      let bestDistance = Infinity
      for (const paper of papers) {
        if (claimed.has(paper.id)) continue
        const d = distance(here, paper)
        if (d < bestDistance) {
          best = paper
          bestDistance = d
        }
      }
      if (best) {
        holi.goal = best.id
        target = best
      } else if (holi.carry.length > 0) {
        target = nearestOutbox()
      } else {
        if (!holi.wander || distance(here, holi.wander) === 0) {
          holi.wander = freeTile()
        }
        target = holi.wander
      }
    }
    if (!target) return

    const moving = holi.dx !== 0 || holi.dy !== 0
    const options = DIRS.filter((dir) => !moving || !(dir.x === -holi.dx && dir.y === -holi.dy))
    let choice: Tile = options[0]!
    let bestScore = -Infinity
    for (const dir of options) {
      const next = { x: wrapX(holi.tx + dir.x), y: wrapY(holi.ty + dir.y) }
      const value = -distance(next, target) - (danger(next.x, next.y) ? 6 : 0) + Math.random() * 0.4
      if (value > bestScore) {
        bestScore = value
        choice = dir
      }
    }
    holi.dx = choice.x
    holi.dy = choice.y
  }

  /** The player's Holi takes the buffered turn, or keeps going. */
  const steerPlayer = (holi: Holi) => {
    if (!pending) return
    holi.dx = pending.x
    holi.dy = pending.y
    pending = null
  }

  /** Strew a dropped stack about the tiles around where it fell. */
  const scatter = (holi: Holi) => {
    for (const kind of holi.carry) {
      const spot = freeTile({ x: holi.tx, y: holi.ty }, 3)
      if (spot) papers.push({ id: nextPaperId++, ...spot, kind, age: 0 })
    }
    holi.carry = []
    holi.trail = []
  }

  /** What a Holi does on reaching a tile: pick up, file, then choose a way. */
  const arrive = (holi: Holi, isPlayer: boolean) => {
    const paper = paperAt(holi.tx, holi.ty)
    const cap = isPlayer ? PLAYER_CAPACITY : holi.cap
    if (paper && holi.carry.length < cap) {
      papers = papers.filter((it) => it !== paper)
      holi.carry.push(paper.kind)
    }

    if (onOutbox(holi.tx, holi.ty) && holi.carry.length > 0) {
      const count = holi.carry.length
      if (isPlayer) score += stackScore(count)
      outboxFlash = OUTBOX_FLASH_MS
      holi.carry = []
      holi.trail = []
      const face = holiMascotOf(holi.member.mascot)
      const voice = face && VOICE[face]
      const lines =
        count >= 4 && Math.random() < 0.5
          ? STACK_LINES
          : voice && Math.random() < 0.45
            ? voice
            : FILED_LINES
      say(lines, holi.member.id, isPlayer)
    }

    if (isPlayer) steerPlayer(holi)
    else think(holi)
  }

  const moveHoli = (holi: Holi, dt: number, isPlayer: boolean) => {
    if (holi.stun > 0) {
      holi.stun -= dt
      return
    }
    if (!holi.dx && !holi.dy) {
      if (isPlayer) steerPlayer(holi)
      else think(holi)
      if (!holi.dx && !holi.dy) return
    }
    const tick = isPlayer ? MODE_TICK[mode] : player ? RIVAL_TICK : IDLE_TICK
    holi.progress += dt / tick
    while (holi.progress >= 1) {
      holi.progress -= 1
      holi.trail.unshift({ x: holi.tx, y: holi.ty })
      holi.tx = wrapX(holi.tx + holi.dx)
      holi.ty = wrapY(holi.ty + holi.dy)
      holi.steps++
      arrive(holi, isPlayer)
      holi.trail.length = Math.min(holi.trail.length, holi.carry.length)
      if (!holi.dx && !holi.dy) {
        holi.progress = 0
        break
      }
    }
  }

  const moveConflict = (conflict: Mover, dt: number) => {
    const tick = (player ? MODE_TICK[mode] : IDLE_TICK) * CONFLICT_SLOW
    conflict.progress += dt / tick
    while (conflict.progress >= 1) {
      conflict.progress -= 1
      conflict.tx = wrapX(conflict.tx + conflict.dx)
      conflict.ty = wrapY(conflict.ty + conflict.dy)
      // Mostly on its way, sometimes a turn; while you play, it leans
      // towards your Holi now and then.
      const lead = player ? holis[0] : undefined
      const roll = Math.random()
      if (lead && roll < 0.3) {
        const sx = Math.sign(span(conflict.tx, lead.tx, tileCols))
        const sy = Math.sign(span(conflict.ty, lead.ty, tileRows))
        if (sx && (Math.random() < 0.5 || !sy)) {
          conflict.dx = sx
          conflict.dy = 0
        } else if (sy) {
          conflict.dx = 0
          conflict.dy = sy
        }
      } else if (roll > 0.72) {
        const turn = pick(DIRS.filter((d) => !(d.x === -conflict.dx && d.y === -conflict.dy)))
        conflict.dx = turn.x
        conflict.dy = turn.y
      }
    }
  }

  /** A Holi walking into a conflict drops its stack and stands dazed; the
   *  conflict is resolved, and another turns up elsewhere. */
  const collide = () => {
    holis.forEach((holi, index) => {
      if (holi.stun > 0) return
      for (let i = 0; i < conflicts.length; i++) {
        const conflict = conflicts[i]!
        const dx = Math.abs(span(atX(conflict), atX(holi), tileCols))
        const dy = Math.abs(span(atY(conflict), atY(holi), tileRows))
        if (dx > 0.6 || dy > 0.6) continue
        const isPlayer = player && index === 0
        scatter(holi)
        holi.stun = STUN_MS
        say(CONFLICT_LINES, holi.member.id, isPlayer)
        conflicts[i] = spawnConflict()
        return
      }
    })
  }

  /** 0 while fading in, ramping to 1 — keeps resizes from popping. */
  const bootAlpha = () => Math.min(1, booted / BOOT_FADE_MS)

  const centreX = (x: number) => cellX(x) + (TILE - 1) / 2
  const centreY = (y: number) => cellY(y) + (TILE - 1) / 2

  return {
    resize(nextCols: number, nextRows: number) {
      if (nextCols === cols && nextRows === rows) return
      const keepScore = player && ready
      const kept = score
      cols = nextCols
      rows = nextRows
      if (keepScore) {
        rebuild()
        score = kept
      } else {
        boot()
      }
    },

    setKeepOut(rects: readonly CellRect[]) {
      keepOut = rects
      if (!ready) return
      markKeepOut()
      // Papers already under the new keep-out go; the rest stay put.
      papers = papers.filter((paper) => !isKept(paper.x, paper.y))
    },

    setCast(next: readonly ArcadeCastMember[]) {
      const same =
        next.length === cast.length &&
        next.every(
          (member, i) =>
            member.id === cast[i]?.id &&
            member.mascot === cast[i]?.mascot &&
            member.color === cast[i]?.color &&
            member.name === cast[i]?.name,
        )
      if (same) return
      cast = next
      if (ready) placeHolis()
    },

    /** Hands the first Holi over to the caller; the rest keep their brains. */
    takeControl() {
      if (player) return
      player = true
      boot()
    },

    /** Puts the idle brain back in the seat. */
    releaseControl() {
      if (!player) return
      player = false
      boot()
    },

    /**
     * Queue the next heading, taken at the next tile. A turn back the way it
     * came lands at once, as in pac-man.
     */
    steer(x: number, y: number) {
      if (!player || !ready) return
      if (Math.abs(x) + Math.abs(y) !== 1) return
      const holi = holis[0]
      if (!holi) return
      if (!holi.dx && !holi.dy) {
        holi.dx = x
        holi.dy = y
        pending = null
        return
      }
      if (x === -holi.dx && y === -holi.dy) {
        reverse(holi)
        pending = null
        return
      }
      pending = { x, y }
    },

    setMode(next: ArcadeMode) {
      mode = next
    },

    mode() {
      return mode
    },

    controlled() {
      return player
    },

    score() {
      return score
    },

    carrying() {
      return player ? (holis[0]?.carry.length ?? 0) : 0
    },

    lead() {
      return holis[0]?.member ?? cast[0] ?? DEFAULT_CAST[0]!
    },

    step(dt: number) {
      booted += dt
      if (!ready) return

      if (speech) {
        speech.age += dt
        if (speech.age >= SPEECH_HOLD_MS + SPEECH_FADE_MS) speech = null
      }
      if (outboxFlash > 0) outboxFlash = Math.max(0, outboxFlash - dt)
      for (const paper of papers) paper.age += dt
      for (const holi of holis) holi.talk = Math.max(0, holi.talk - dt)

      paperTimer -= dt
      if (paperTimer <= 0) {
        spawnPaper()
        paperTimer = player ? PLAYER_PAPER_GAP_MS : PAPER_GAP_MS
      }

      while (conflicts.length < conflictCount()) {
        conflicts.push(spawnConflict())
      }

      holis.forEach((holi, index) => moveHoli(holi, dt, player && index === 0))
      for (const conflict of conflicts) moveConflict(conflict, dt)
      collide()
    },

    /** The line to float over whoever said it. */
    speechBubble(): SpeechBubble | null {
      if (!speech || !ready) return null
      const from = speech.from
      const speaker = holis.find((holi) => holi.member.id === from)
      if (!speaker) return null
      return {
        text: speech.text,
        x: Math.round(centreX(atX(speaker))),
        y: Math.round(cellY(atY(speaker))),
        alpha: speechAlpha(speech) * bootAlpha(),
        accent: speaker.member.color,
      }
    },

    /** The Holis, their stacks and the conflicts, ready to draw. */
    sprites(): ArcadeSprite[] {
      if (!ready) return []
      const alpha = bootAlpha()
      const out: ArcadeSprite[] = []

      holis.forEach((holi, index) => {
        const isPlayer = player && index === 0
        const rival = player && !isPlayer
        // The stack rides the tiles just left, sliding along with the Holi.
        holi.trail.forEach((tile, i) => {
          const kind = holi.carry[holi.carry.length - 1 - i] ?? 'doc'
          const from = { x: tile.x, y: tile.y }
          const to = i === 0 ? { x: holi.tx, y: holi.ty } : holi.trail[i - 1]!
          const jump = Math.abs(to.x - from.x) > 1 || Math.abs(to.y - from.y) > 1
          const t = holi.stun > 0 || jump ? 0 : holi.progress
          const at = {
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t,
          }
          out.push({
            kind: 'paper',
            paper: kind,
            cx: centreX(at.x),
            cy: centreY(at.y),
            size: TILE * 0.62,
            alpha: alpha * (rival ? 0.55 : 1),
            color: holi.member.color,
          })
        })

        const dazed = holi.stun > 0 && Math.floor(holi.stun / STUN_BLINK_MS) % 2 === 0
        out.push({
          kind: 'holi',
          cx: centreX(atX(holi)),
          cy: centreY(atY(holi)),
          size: TILE,
          dx: holi.dx,
          dy: holi.dy,
          alpha: alpha * (rival ? 0.6 : 1) * (dazed ? 0.35 : 1),
          mascot: holi.member.mascot,
          color: holi.member.color,
          frame:
            holi.talk > 0 ? 'talk' : (holi.dx || holi.dy) && holi.steps % 2 === 1 ? 'walk' : 'rest',
          player: isPlayer,
        })
      })

      for (const conflict of conflicts) {
        out.push({
          kind: 'conflict',
          cx: centreX(atX(conflict)),
          cy: centreY(atY(conflict)),
          size: TILE,
          alpha,
        })
      }
      return out
    },

    /** 0 → 1 over the first paint after mount or resize. */
    fade() {
      return bootAlpha()
    },

    stamp(out: Float32Array, stampCols: number, stampRows: number) {
      if (!ready) return
      const alpha = bootAlpha()

      const light = (x: number, y: number, value: number) => {
        if (x < 0 || y < 0 || x >= stampCols || y >= stampRows) return
        const index = y * stampCols + x
        if ((out[index] ?? 0) < value) out[index] = value
      }
      const glyph = (rows: readonly string[], left: number, top: number, strength: number) => {
        rows.forEach((row, dy) => {
          for (let dx = 0; dx < row.length; dx++) {
            const ch = row[dx]
            if (ch === '#') light(left + dx, top + dy, strength)
            else if (ch === '+') light(left + dx, top + dy, strength * PAPER_SOFT)
          }
        })
      }

      for (const paper of papers) {
        const fadeIn = Math.min(1, paper.age / PAPER_FADE_MS)
        glyph(GLYPHS[paper.kind], cellX(paper.x), cellY(paper.y), PAPER_VALUE * fadeIn)
      }

      const flash = outboxFlash / OUTBOX_FLASH_MS
      glyph(
        GLYPHS.outbox,
        cellX(outbox.x),
        cellY(outbox.y),
        OUTBOX_VALUE + (1 - OUTBOX_VALUE) * flash,
      )

      if (alpha >= 0.999) return
      for (let i = 0; i < out.length; i++) out[i]! *= alpha
    },
  }
}
