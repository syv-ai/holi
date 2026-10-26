/**
 * Shared types for the empty-view grid games.
 *
 * Adapted from MonoCode's `features/terminal/arcade/gridArcade.ts`
 * (https://github.com/hardbeat920/monocode), MIT License, Copyright (c) 2026
 * Nick; see license in this folder. The interface and its tick model are
 * MonoCode's; the provider-logo pickup is gone, and the sprites are Holi's
 * own cast, papers and conflicts.
 *
 * A game speaks `GridArcade` so the canvas renderer (`holi-arcade.tsx`) can
 * host it without knowing its rules.
 */
import type { ArcadeCastMember } from "@/state/plugin-types"

export type { ArcadeCastMember }

export const ARCADE_MODES = ["low", "mid", "hard"] as const
export type ArcadeMode = (typeof ARCADE_MODES)[number]

/** A pixel speech bubble trailing whoever is talking. */
export type SpeechBubble = {
  text: string
  /** Grid cell the tail points at. */
  x: number
  y: number
  alpha: number
  /** The speaker's own colour, for the bubble's outline. */
  accent: string
}

/** A block of grid cells, for the parts of the pane the board keeps clear of. */
export type CellRect = { x: number; y: number; w: number; h: number }

/** What a paper on the board is: a document, or a task. */
export type PaperKind = "doc" | "task"

/** A drawn piece on top of the stamped grid: a Holi, a carried paper, a conflict. */
export type ArcadeSprite =
  | {
      kind: "holi"
      /** Centre of the sprite, in grid cells. */
      cx: number
      cy: number
      /** Side of the sprite, in grid cells. */
      size: number
      /** Heading, for which way the figure leans. */
      dx: number
      dy: number
      alpha: number
      /** Its persona: one of `HOLI_MASCOTS`. */
      mascot: string
      color: string
      /** Standing, mid-step, or saying something (`speechBubble`). */
      frame: "rest" | "walk" | "talk"
      /** The one the player steers. */
      player: boolean
    }
  | {
      kind: "paper"
      paper: PaperKind
      cx: number
      cy: number
      size: number
      alpha: number
      /** Whose stack it rides in. */
      color: string
    }
  | {
      kind: "conflict"
      cx: number
      cy: number
      size: number
      alpha: number
    }

/**
 * One idle-or-playable board on the empty-view grid. It plays itself until
 * someone takes control, and hands it back on release.
 */
export type GridArcade = {
  resize(nextCols: number, nextRows: number): void
  /** Cells the board keeps its spawns out of (the logo, say). */
  setKeepOut(rects: readonly CellRect[]): void
  /** Who is on the board. An empty cast brings the default one. */
  setCast(cast: readonly ArcadeCastMember[]): void
  takeControl(): void
  releaseControl(): void
  steer(x: number, y: number): void
  setMode(next: ArcadeMode): void
  mode(): ArcadeMode
  controlled(): boolean
  score(): number
  /** How many papers the player's Holi is carrying. */
  carrying(): number
  /** The Holi the player steers, or the first of the cast. */
  lead(): ArcadeCastMember | null
  step(dt: number): void
  speechBubble(): SpeechBubble | null
  sprites(): ArcadeSprite[]
  fade(): number
  stamp(out: Float32Array, stampCols: number, stampRows: number): void
}
