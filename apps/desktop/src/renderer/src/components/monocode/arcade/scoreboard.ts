/**
 * Paper run's scoreboard: every player's best run at each speed, committed
 * with the vault so a team plays against each other.
 *
 * **One file per player**, `.holi/arcade/scores/<login>.json`, written only
 * by that player's machines. Two people setting records at once then touch
 * different files, and the vault's sync never stops on a conflict over a
 * game. A file names its player again inside, so a renamed file still
 * credits the right person.
 */
import { ARCADE_MODES, type ArcadeMode } from "./gridArcade"

export const SCORES_DIR = ".holi/arcade/scores/"

export interface BestRun {
  score: number
  /** When it was set, as an ISO timestamp. */
  at: string
}

export interface PlayerScores {
  login: string
  name?: string
  avatarUrl?: string
  best: Partial<Record<ArcadeMode, BestRun>>
}

/** One row of the board at one speed. */
export interface BoardRow {
  login: string
  name?: string
  avatarUrl?: string
  score: number
  at: string
}

/** A GitHub login as a file name: logins are already `[A-Za-z0-9-]`, so
 *  this only guards against a malformed one. */
export function scoresPath(login: string): string {
  return `${SCORES_DIR}${login.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.json`
}

export function isScoresPath(path: string): boolean {
  return (
    path.startsWith(SCORES_DIR) &&
    path.endsWith(".json") &&
    !path.slice(SCORES_DIR.length).includes("/")
  )
}

function bestRun(raw: unknown): BestRun | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const { score, at } = raw as Record<string, unknown>
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0)
    return undefined
  return { score: Math.floor(score), at: typeof at === "string" ? at : "" }
}

/** A player's file, or null when it is not one: a hand-edited or broken
 *  file drops off the board rather than breaking it. */
export function parsePlayerScores(text: string): PlayerScores | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null) return null
  const data = raw as Record<string, unknown>
  if (typeof data.login !== "string" || data.login === "") return null
  const best: PlayerScores["best"] = {}
  const rawBest =
    typeof data.best === "object" && data.best !== null
      ? (data.best as Record<string, unknown>)
      : {}
  for (const mode of ARCADE_MODES) {
    const run = bestRun(rawBest[mode])
    if (run) best[mode] = run
  }
  return {
    login: data.login,
    ...(typeof data.name === "string" ? { name: data.name } : {}),
    ...(typeof data.avatarUrl === "string"
      ? { avatarUrl: data.avatarUrl }
      : {}),
    best,
  }
}

export function serializePlayerScores(scores: PlayerScores): string {
  return `${JSON.stringify(scores, null, 2)}\n`
}

/**
 * A finished run against the player's file: the file to write when it is a
 * new best at that speed, or null when it is not (nothing is written, so
 * an ordinary run makes no commit).
 */
export function recordRun(
  current: PlayerScores | null,
  player: { login: string; name?: string; avatarUrl?: string },
  mode: ArcadeMode,
  score: number,
  at: string
): PlayerScores | null {
  if (score <= 0) return null
  const previous = current?.best[mode]
  if (previous !== undefined && previous.score >= score) return null
  return {
    login: player.login,
    ...(player.name ? { name: player.name } : {}),
    ...(player.avatarUrl ? { avatarUrl: player.avatarUrl } : {}),
    best: { ...current?.best, [mode]: { score, at } },
  }
}

/** The board at one speed: highest first, the earlier run winning a tie. */
export function boardFor(
  players: readonly PlayerScores[],
  mode: ArcadeMode
): BoardRow[] {
  const rows: BoardRow[] = []
  for (const player of players) {
    const run = player.best[mode]
    if (!run) continue
    rows.push({
      login: player.login,
      ...(player.name ? { name: player.name } : {}),
      ...(player.avatarUrl ? { avatarUrl: player.avatarUrl } : {}),
      score: run.score,
      at: run.at,
    })
  }
  return rows.sort((a, b) => b.score - a.score || a.at.localeCompare(b.at))
}

const SPEED_ORDER: Record<ArcadeMode, number> = { low: 0, mid: 1, hard: 2 }

/** A run counts at the slowest speed it was played at, so starting slow and
 *  switching to Fast for the record does not count as a Fast run. */
export function slowerMode(a: ArcadeMode, b: ArcadeMode): ArcadeMode {
  return SPEED_ORDER[a] <= SPEED_ORDER[b] ? a : b
}
