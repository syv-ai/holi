/**
 * Paper run's rules. The harness (run a board for a while at a fixed frame,
 * watch what it stamps and says) follows MonoCode's arcade tests
 * (https://github.com/hardbeat920/monocode), MIT License, Copyright (c) 2026
 * Nick; see LICENSE in this folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ArcadeSprite, GridArcade } from "./gridArcade"
import {
  DEFAULT_CAST,
  MAX_CAST,
  TILE,
  createPaperRun,
  stackScore,
} from "./paperRun"

/** A wide pane: 7px cells over roughly 1100×700, a whole number of tiles. */
const COLS = 156
const ROWS = 100
const FRAME_MS = 33

const CAST = [
  { id: "proposal", name: "Proposal", mascot: "rocket", color: "#a5a1ff" },
  { id: "assistant", name: "Assistant", mascot: "frog", color: "#7ee0b5" },
]

/** A seeded `Math.random`, so a board plays the same way every run. */
function seed(start: number) {
  let state = start >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(seed(7))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function board(cast = CAST, cols = COLS, rows = ROWS) {
  const arcade = createPaperRun()
  arcade.setCast(cast)
  arcade.resize(cols, rows)
  return arcade
}

function holis(arcade: GridArcade) {
  return arcade
    .sprites()
    .filter(
      (sprite): sprite is Extract<ArcadeSprite, { kind: "holi" }> =>
        sprite.kind === "holi"
    )
}

function run(arcade: GridArcade, ms: number, each?: () => void) {
  for (let t = 0; t < ms; t += FRAME_MS) {
    arcade.step(FRAME_MS)
    each?.()
  }
}

describe("paper run", () => {
  it("fades the board in instead of painting at full strength", () => {
    const arcade = board()
    expect(arcade.fade()).toBe(0)
    arcade.step(FRAME_MS)
    expect(arcade.fade()).toBeGreaterThan(0)
    expect(arcade.fade()).toBeLessThan(1)
    arcade.step(500)
    expect(arcade.fade()).toBe(1)
  })

  it("puts the vault's Holis on the board, as themselves", () => {
    const arcade = board()
    arcade.step(FRAME_MS)
    const onBoard = holis(arcade)
    expect(onBoard.map((sprite) => sprite.mascot)).toEqual(["rocket", "frog"])
    expect(onBoard.map((sprite) => sprite.color)).toEqual([
      "#a5a1ff",
      "#7ee0b5",
    ])
    expect(arcade.lead()?.name).toBe("Proposal")
  })

  it("brings the default cast when the vault has none", () => {
    const arcade = board([])
    arcade.step(FRAME_MS)
    expect(holis(arcade).map((sprite) => sprite.mascot)).toEqual(
      DEFAULT_CAST.map((member) => member.mascot)
    )
  })

  it("puts at most a handful on the board", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `h${i}`,
      name: `H${i}`,
      mascot: "ghost",
      color: "#f28fb1",
    }))
    const arcade = board(many)
    arcade.step(FRAME_MS)
    expect(holis(arcade)).toHaveLength(MAX_CAST)
  })

  it("keeps a Holi where it was when the cast changes around it", () => {
    const arcade = board()
    run(arcade, 3000)
    const before = holis(arcade)[0]!
    arcade.setCast([
      CAST[0]!,
      { id: "new", name: "New", mascot: "cat", color: "#f0b46a" },
    ])
    const after = holis(arcade)
    expect(after.map((sprite) => sprite.mascot)).toEqual(["rocket", "cat"])
    expect(after[0]!.cx).toBe(before.cx)
    expect(after[0]!.cy).toBe(before.cy)
  })

  it("plays itself: the Holis walk, file papers and say so", () => {
    const arcade = board()
    run(arcade, 500)
    const start = holis(arcade).map((sprite) => `${sprite.cx},${sprite.cy}`)
    const said = new Set<string>()
    const accents = new Set<string>()
    run(arcade, 90_000, () => {
      const bubble = arcade.speechBubble()
      if (!bubble) return
      said.add(bubble.text)
      accents.add(bubble.accent)
    })
    const end = holis(arcade).map((sprite) => `${sprite.cx},${sprite.cy}`)
    expect(end).not.toEqual(start)
    expect(said.size).toBeGreaterThanOrEqual(3)
    // Every line is in a Holi of the cast's own colour.
    for (const accent of accents) {
      expect(CAST.map((member) => member.color)).toContain(accent)
    }
    // Idle play never scores: the score is the player's.
    expect(arcade.score()).toBe(0)
  })

  it("never says the same thing twice running", () => {
    const arcade = board()
    const said: string[] = []
    run(arcade, 300_000, () => {
      const bubble = arcade.speechBubble()
      if (bubble && bubble.text !== said[said.length - 1])
        said.push(bubble.text)
    })
    expect(said.length).toBeGreaterThan(5)
    for (let i = 1; i < said.length; i++) expect(said[i]).not.toBe(said[i - 1])
  })

  it("keeps every stamped cell inside the intensity range", () => {
    const arcade = board()
    const stamp = new Float32Array(COLS * ROWS)
    let peak = 0
    run(arcade, 20_000, () => {
      stamp.fill(0)
      arcade.stamp(stamp, COLS, ROWS)
      for (const value of stamp) peak = Math.max(peak, value)
    })
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(1)
  })

  it("puts nothing in the keep-out", () => {
    const arcade = createPaperRun()
    arcade.setCast(CAST)
    const keep = { x: 20, y: 12, w: 60, h: 40 }
    arcade.setKeepOut([keep])
    arcade.resize(COLS, ROWS)
    const stamp = new Float32Array(COLS * ROWS)
    let inside = 0
    let outside = 0
    let frame = 0
    run(arcade, 60_000, () => {
      if (frame++ % 10) return
      stamp.fill(0)
      arcade.stamp(stamp, COLS, ROWS)
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const lit = stamp[y * COLS + x]! > 0
          const kept =
            x >= keep.x &&
            x < keep.x + keep.w &&
            y >= keep.y &&
            y < keep.y + keep.h
          if (lit && kept) inside++
          else if (lit) outside++
        }
      }
    })
    expect(inside).toBe(0)
    expect(outside).toBeGreaterThan(0)
  })

  it("survives small and awkward grids", () => {
    for (const [cols, rows] of [
      [8, 4],
      [33, 21],
      [40, 22],
      [300, 40],
    ] as const) {
      const arcade = board(CAST, cols, rows)
      expect(() =>
        run(arcade, 10_000, () => {
          arcade.sprites()
          arcade.speechBubble()
          arcade.stamp(new Float32Array(cols * rows), cols, rows)
        })
      ).not.toThrow()
    }
  })

  it("stays a plain grid on a board too small to play", () => {
    const arcade = board(CAST, 20, 12)
    run(arcade, 2000)
    expect(arcade.sprites()).toEqual([])
    const stamp = new Float32Array(20 * 12)
    arcade.stamp(stamp, 20, 12)
    expect(Math.max(...stamp)).toBe(0)
  })

  it("handles being stepped before it has a size", () => {
    const arcade = createPaperRun()
    expect(() => {
      arcade.step(FRAME_MS)
      arcade.stamp(new Float32Array(0), 0, 0)
      expect(arcade.sprites()).toEqual([])
      expect(arcade.speechBubble()).toBeNull()
    }).not.toThrow()
  })

  it("reboots cleanly when the pane is resized", () => {
    const arcade = board()
    for (const [cols, rows] of [
      [COLS, ROWS],
      [60, 40],
      [240, 140],
      [COLS, ROWS],
    ] as const) {
      arcade.resize(cols, rows)
      run(arcade, 4000)
      expect(() =>
        arcade.stamp(new Float32Array(cols * rows), cols, rows)
      ).not.toThrow()
    }
  })
})

/** Where the player's Holi stands, in tiles. */
function playerTile(arcade: GridArcade) {
  const me = holis(arcade).find((sprite) => sprite.player)!
  return {
    x: Math.round((me.cx - (TILE - 1) / 2) / TILE),
    y: Math.round((me.cy - (TILE - 1) / 2) / TILE),
  }
}

describe("paper run player control", () => {
  it("scores 1 + 2 + … + n for a stack of n", () => {
    expect(stackScore(1)).toBe(1)
    expect(stackScore(3)).toBe(6)
    expect(stackScore(5)).toBe(15)
  })

  it("ignores steering until someone takes control", () => {
    const arcade = board()
    expect(arcade.controlled()).toBe(false)
    arcade.steer(0, 1)
    expect(arcade.carrying()).toBe(0)
    expect(holis(arcade).some((sprite) => sprite.player)).toBe(false)
  })

  it("waits for the first key, then goes where it is steered", () => {
    const arcade = board()
    arcade.takeControl()
    expect(arcade.controlled()).toBe(true)
    run(arcade, 1000)
    const start = playerTile(arcade)
    // Standing still until told otherwise.
    run(arcade, 1000)
    expect(playerTile(arcade)).toEqual(start)

    arcade.steer(0, 1)
    // Mid speed: 150ms a tile.
    run(arcade, 150 * 3 + 20)
    const moved = playerTile(arcade)
    expect(moved.x).toBe(start.x)
    expect(moved.y).not.toBe(start.y)
  })

  it("turns back on the spot rather than at the next tile", () => {
    const arcade = board()
    arcade.takeControl()
    arcade.steer(1, 0)
    run(arcade, 150 * 2 + 70)
    const me = () => holis(arcade).find((sprite) => sprite.player)!
    const heading = me().dx
    arcade.steer(-1, 0)
    expect(me().dx).toBe(-heading)
  })

  it("lets hard outrun low", () => {
    const distanceIn = (mode: "low" | "hard") => {
      const arcade = board()
      arcade.setMode(mode)
      arcade.takeControl()
      const start = holis(arcade).find((sprite) => sprite.player)!.cx
      arcade.steer(1, 0)
      run(arcade, 600)
      const end = holis(arcade).find((sprite) => sprite.player)!.cx
      return Math.abs(end - start)
    }
    expect(distanceIn("hard")).toBeGreaterThan(distanceIn("low"))
  })

  it("picks papers up and files them for points", () => {
    const arcade = createPaperRun()
    arcade.setCast(CAST)
    arcade.resize(COLS, ROWS)
    arcade.takeControl()
    const tileCols = Math.floor(COLS / TILE)
    const tileRows = Math.floor(ROWS / TILE)
    const stamp = new Float32Array(COLS * ROWS)
    const value = (tx: number, ty: number, x = 0, y = 0) =>
      stamp[(ty * TILE + y) * COLS + tx * TILE + x] ?? 0
    const span = (a: number, b: number, size: number) => {
      const direct = b - a
      const around = direct - Math.sign(direct) * size
      return Math.abs(direct) <= Math.abs(around) ? direct : around
    }

    // The outbox's arrow is the only top-left tile lit at (3, 0) and dark
    // at (0, 0); found once the board has faded in.
    run(arcade, 500)
    stamp.fill(0)
    arcade.stamp(stamp, COLS, ROWS)
    let outbox: { x: number; y: number } | null = null
    for (let ty = 0; ty < tileRows && !outbox; ty++) {
      for (let tx = 0; tx < tileCols; tx++) {
        if (value(tx, ty, 3, 0) > 0.4 && value(tx, ty, 0, 0) === 0) {
          outbox = { x: tx, y: ty }
          break
        }
      }
    }
    expect(outbox).not.toBeNull()

    // A plain bot: the nearest paper, and the outbox once it holds three.
    let peak = 0
    run(arcade, 120_000, () => {
      peak = Math.max(peak, arcade.carrying())
      stamp.fill(0)
      arcade.stamp(stamp, COLS, ROWS)
      const me = playerTile(arcade)
      let target = outbox!
      if (arcade.carrying() < 3) {
        let best = Infinity
        for (let ty = 0; ty < tileRows; ty++) {
          for (let tx = 0; tx < tileCols; tx++) {
            const lit = value(tx, ty)
            if (lit < 0.8 || lit > 0.9) continue
            const d =
              Math.abs(span(me.x, tx, tileCols)) +
              Math.abs(span(me.y, ty, tileRows))
            if (d < best) {
              best = d
              target = { x: tx, y: ty }
            }
          }
        }
      }
      const sx = Math.sign(span(me.x, target.x, tileCols))
      const sy = Math.sign(span(me.y, target.y, tileRows))
      if (sx) arcade.steer(sx, 0)
      else if (sy) arcade.steer(0, sy)
    })

    expect(peak).toBeGreaterThanOrEqual(2)
    expect(arcade.score()).toBeGreaterThan(0)
  })

  it("hands the idle brain back when control is released", () => {
    const arcade = board()
    arcade.takeControl()
    arcade.steer(1, 0)
    run(arcade, 2000)
    arcade.releaseControl()
    expect(arcade.controlled()).toBe(false)
    expect(arcade.score()).toBe(0)
    expect(holis(arcade).some((sprite) => sprite.player)).toBe(false)
  })

  it("keeps a live game's score when the pane is resized", () => {
    const arcade = board()
    arcade.takeControl()
    arcade.resize(COLS - 40, ROWS + 12)
    expect(arcade.controlled()).toBe(true)
    expect(arcade.mode()).toBe("mid")
    run(arcade, 1000)
    expect(holis(arcade).some((sprite) => sprite.player)).toBe(true)
  })
})
