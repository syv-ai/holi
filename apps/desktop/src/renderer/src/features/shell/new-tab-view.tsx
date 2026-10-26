import { useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { AstroidIcon, CalendarDaysIcon, FilePlusIcon } from 'lucide-react'

import { ArcadeTakeControl, HoliArcade } from '@/composites/arcade/holi-arcade'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { BrandMark } from '@/composites/brand-mark'
import { cn } from '@/lib/cn'
import { newAgentSessionAtom } from '@/state/agents-slots'
import { todayAtom } from '@/state/clock'
import { ensureTodaysDailyAtom } from '@/state/daily'
import { arcadeCastAtom, gridArcadeAtom } from '@/state/grid-arcade'
import { runningPluginsAtom } from '@/state/plugins'
import { openTaskCountAtom } from '@/state/tasks'
import { activeRemoteAtom, vaultsAtom } from '@/state/vaults'

import { BOARD_TAB } from '../sidebar/documents-nav'

/** A tab opened with +: it shows this view until something is picked in it,
 *  and then becomes that thing. Nothing is written to the vault until then.
 * @public exported for its test
 */
export const NEW_TAB_PREFIX = 'holi:new:'

/** "Friday 23 October", from the clock's `YYYY-MM-DD`. */
const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

function dayLabel(today: string): string {
  const [year = 1970, month = 1, day = 1] = today.split('-').map(Number)
  return DAY.format(new Date(year, month - 1, day))
}

/**
 * What the view shows when nothing is open, or in a New tab
 * (docs/features/tabs-panes.md): where you are (the vault, the day and the
 * open tasks, which open the board), the mark, and the three things you
 * would start: a document, today's note, an agent session. Behind it, the
 * Holis' arcade (docs/features/tabs-panes.md, The arcade).
 */
export function NewTabView({
  onOpen,
  onNewDocument,
}: {
  /** Open a vault path or the board, in place of a New tab. */
  onOpen: (id: string) => void
  onNewDocument: () => void
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const vaults = useAtomValue(vaultsAtom)
  const today = useAtomValue(todayAtom)
  const openTasks = useAtomValue(openTaskCountAtom)
  const ensureDaily = useSetAtom(ensureTodaysDailyAtom)
  const newAgentSession = useSetAtom(newAgentSessionAtom)
  /** A new agent session only where the agent can start one. */
  const hasAgents = useAtomValue(runningPluginsAtom).some(
    (plugin) => plugin.agentsMode?.newSession !== undefined,
  )

  const arcadeOn = useAtomValue(gridArcadeAtom)
  const cast = useAtomValue(arcadeCastAtom)
  /** While someone plays, the board covers the pane and the content steps
   *  out; Escape or Release brings it back, focus on the take-control pill. */
  const [playing, setPlaying] = useState(false)
  /** The pointer is over the board's free ground, not over the content. */
  const [overBoard, setOverBoard] = useState(false)
  const columnRef = useRef<HTMLDivElement>(null)
  const takeControlRef = useRef<HTMLButtonElement>(null)
  const wasPlaying = useRef(false)

  useEffect(() => {
    if (wasPlaying.current && !playing) takeControlRef.current?.focus()
    wasPlaying.current = playing
  }, [playing])

  /** Over the board when the pointer is on the scroller or the column itself
   *  (the gaps between things), or on the take-control pill's own row. */
  function trackBoard(event: React.PointerEvent<HTMLDivElement>) {
    const target = event.target as Element
    const free =
      target === event.currentTarget ||
      target === columnRef.current ||
      target.closest('[data-arcade-free]') !== null
    if (free !== overBoard) setOverBoard(free)
  }

  const vaultName = vaults.find((vault) => vault.remote === remote)?.name ?? remote

  async function openToday() {
    try {
      const path = await ensureDaily()
      if (path !== null) onOpen(path)
    } catch {
      toast.error('Couldn’t open today’s note. Check that the vault is reachable, then try again.')
    }
  }

  return (
    <div
      data-slot="empty-view"
      className="@container relative isolate flex min-h-0 flex-1 flex-col"
    >
      {/* The Holis' arcade, under everything and melting into the pane:
          content wins, so it takes no pointer until someone takes control,
          and then it covers the pane. Gone below a 48rem pane;
          machine-local, on by default (`gridArcade`). */}
      {arcadeOn ? (
        <HoliArcade
          cast={cast}
          playing={playing}
          onRelease={() => setPlaying(false)}
          className="hidden @3xl:block"
        />
      ) : null}
      {/* The content scrolls over a board that stays put, and steps out
          while a game is on. */}
      <div
        data-slot="empty-view-content"
        inert={playing}
        aria-hidden={playing || undefined}
        onPointerMove={arcadeOn ? trackBoard : undefined}
        onPointerLeave={() => setOverBoard(false)}
        className={cn(
          'relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto motion-respond',
          playing && 'opacity-0',
        )}
      >
        {/* Centred in the pane; no entrance, since a New tab opens many times
          a day and lands at once everywhere else. */}
        <div
          ref={columnRef}
          className="mx-auto my-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-8"
        >
          <header className="flex flex-col gap-1">
            {vaultName ? (
              <p className="text-muted-foreground text-xs font-medium">{vaultName}</p>
            ) : null}
            <h1 className="text-2xl leading-tight font-semibold tracking-tight">
              {dayLabel(today)}
            </h1>
            <p className="text-muted-foreground flex items-center text-sm">
              <span className="text-foreground font-medium tabular-nums">
                {openTasks === 0 ? 'No' : openTasks}
              </span>
              &nbsp;open
              <Button
                type="button"
                variant="link"
                onClick={() => onOpen(BOARD_TAB)}
                className="text-foreground"
              >
                {openTasks === 1 ? 'task' : 'tasks'}
              </Button>
            </p>
          </header>

          {/* The arcade keeps clear of the mark (`data-arcade-keepout`). */}
          <div data-arcade-keepout="" className="w-fit">
            <BrandMark size="xl" className="text-foreground" />
          </div>

          <section aria-labelledby="start" className="flex flex-col gap-2">
            <h2 id="start" className="text-muted-foreground text-xs font-medium">
              Start
            </h2>
            <div role="list" className="grid gap-2 @lg:grid-cols-3">
              <StartCard icon={<FilePlusIcon />} label="New document" onClick={onNewDocument} />
              <StartCard
                icon={<CalendarDaysIcon />}
                label="Today’s note"
                onClick={() => void openToday()}
              />
              {hasAgents ? (
                <StartCard
                  icon={<AstroidIcon />}
                  label="New agent session"
                  onClick={() => void newAgentSession()}
                />
              ) : null}
            </div>
          </section>

          {/* MonoCode's take-control pill, in the band under the content
            rather than over it: shown while the pointer is on the board's
            free ground, or on keyboard focus. */}
          {arcadeOn ? (
            <div data-arcade-free="" className="hidden justify-center py-2 @3xl:flex">
              <ArcadeTakeControl
                ref={takeControlRef}
                show={overBoard}
                onClick={() => setPlaying(true)}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function StartCard({
  icon,
  label,
  keys,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  /** Its shortcut, shown at the card's end. */
  keys?: string
  onClick: () => void
}) {
  return (
    // The group is a list; the card's button keeps its own role inside it.
    <div role="listitem">
      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={onClick}
        className="w-full justify-start font-normal"
      >
        <span aria-hidden="true" className="text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 truncate">{label}</span>
        {keys ? <Kbd className="ms-auto">{keys}</Kbd> : null}
      </Button>
    </div>
  )
}
