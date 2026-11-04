import { TrophyIcon } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/cn'

import type { ArcadeMode } from './grid-arcade'
import { boardFor, type PlayerScores } from './scoreboard'

/** How many places the board shows; the player's own place follows when
 *  they are below it. */
const PLACES = 5

/**
 * The vault's best runs at the speed being played, beside the game: the top
 * places, the player's own row marked, and their place under the cut when
 * they are not in it. Live: a run that beats a row climbs past it as it
 * scores, before it is written.
 */
export function ArcadeScoreboard({
  players,
  me,
  mode,
  modeLabel,
  score,
  className,
}: {
  players: readonly PlayerScores[]
  me: string | null
  mode: ArcadeMode
  modeLabel: string
  /** The run in play, ranked live among the bests. */
  score: number
  className?: string
}) {
  const mine = (login: string) => me !== null && login.toLowerCase() === me.toLowerCase()
  const rows = boardFor(players, mode)
  const myBest = rows.find((row) => mine(row.login))?.score ?? 0
  // The run in play replaces the player's row once it beats their best.
  const live =
    me !== null && score > myBest
      ? boardFor(
          [
            ...players.filter((p) => !mine(p.login)),
            {
              login: me,
              ...(players.find((p) => mine(p.login)) ?? {}),
              best: { [mode]: { score, at: '~' } },
            },
          ],
          mode,
        )
      : rows
  const myPlace = live.findIndex((row) => mine(row.login))
  const shown = live.slice(0, PLACES)

  return (
    <section
      aria-label={`Scoreboard, ${modeLabel}`}
      className={cn(
        'bg-popover/90 text-popover-foreground ring-foreground/10 flex w-56 flex-col gap-2 rounded-lg p-3 shadow-md ring-1 backdrop-blur',
        className,
      )}
    >
      <header className="flex items-center gap-1.5 text-xs font-medium">
        <TrophyIcon aria-hidden="true" className="text-primary size-3.5" />
        Best runs
        <span className="text-muted-foreground ms-auto font-normal">{modeLabel}</span>
      </header>
      {live.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No runs at this speed yet. Score a point to take first place.
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {shown.map((row, index) => (
            <Row key={row.login} place={index + 1} row={row} me={mine(row.login)} />
          ))}
          {myPlace >= PLACES ? <Row place={myPlace + 1} row={live[myPlace]!} me cut /> : null}
        </ol>
      )}
    </section>
  )
}

function Row({
  place,
  row,
  me,
  cut = false,
}: {
  place: number
  row: { login: string; name?: string; avatarUrl?: string; score: number }
  me: boolean
  cut?: boolean
}) {
  const who = row.name ?? row.login
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-md px-1.5 py-1 text-xs tabular-nums',
        me && 'bg-accent text-accent-foreground',
        cut && 'border-border mt-1 border-t pt-2',
      )}
    >
      <span className="text-muted-foreground w-4 text-end">{place}</span>
      <Avatar size="sm">
        {row.avatarUrl ? <AvatarImage src={row.avatarUrl} alt="" /> : null}
        <AvatarFallback className="text-xs">{who.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate">{me ? 'You' : who}</span>
      <span className="font-medium">{row.score}</span>
    </li>
  )
}
