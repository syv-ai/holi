/**
 * The Holis' rows in the Agents Inbox (`AgentsSlot.inbox`): each report that
 * asked for the person (`holi holis report --needs-you`) and that they have not
 * seen, with what it said. Opening it opens the Holi's page, which marks it
 * seen. A run waiting on a permission prompt is the agent's own row there.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { holiAsksAtom, openHoliAtom } from './state'
import { DEFAULT_HOLI_COLOUR, relativeAge } from '@holi/shared'
import { useNow } from '@/plugin-api'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { Button } from '@/components/ui/button'

export function HolisInbox(): React.JSX.Element | null {
  const asks = useAtomValue(holiAsksAtom)
  const open = useSetAtom(openHoliAtom)
  const now = useNow()
  if (asks.length === 0) return null
  return (
    <section aria-label="Holis asking for you" className="flex flex-col gap-2">
      <h2 className="text-xs font-medium text-muted-foreground">Holis asking for you</h2>
      <div className="flex flex-col gap-1">
        {asks.map(({ holi, run }) => (
          <Button
            key={run.jobId}
            variant="ghost"
            className="h-auto w-full text-start font-normal"
            onClick={() => open(holi.id)}
          >
            <span className="flex w-full min-w-0 flex-col gap-1 rounded-lg border border-dashed border-foreground/25 bg-foreground/5 px-1 py-2">
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <PixelPersona
                  name={holi.mascot ?? 'strategist'}
                  color={holi.color ?? DEFAULT_HOLI_COLOUR}
                  status="needs-you"
                />
                <span className="min-w-0 flex-1 truncate">{holi.name}</span>
                <span className="tabular-nums">
                  {run.report === undefined
                    ? ''
                    : relativeAge(new Date(run.report.at).getTime(), now)}
                </span>
              </span>
              <span className="line-clamp-2 text-sm font-semibold whitespace-normal text-foreground">
                {run.report?.text}
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">{run.path}</span>
            </span>
          </Button>
        ))}
      </div>
    </section>
  )
}
