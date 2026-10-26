/**
 * A Holi's page in the Agents view (docs/features/holis.md, A Holi's page),
 * after MonoCode's `MonoHeader` and `MonoOverview` (MIT, Copyright (c) 2026
 * Nick; see NOTICE.md): its face, name and state; whether this machine
 * approved what it says now; then its Runs (what came of each send) and its
 * Habits (the automations it carries out). Its soul, memory and settings are
 * the settings dialog, after MonoCode's `MonoSettingsDialog`.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Clock, Plus, Settings, Sparkles, StickyNote } from 'lucide-react'
import { useEffect, useState } from 'react'
import { activeRemoteAtom, agentsSelectionAtom, useHasCapability } from '@/plugin-api'
import { IconStackEmpty } from '@/components/reui/icon-stack-empty'
import { HoliFeed } from './holi-feed'
import {
  holiSettingsAtom,
  holiStateAtom,
  holisAtom,
  holisEpochAtom,
  holisLoadedAtom,
  loadHolisAtom,
  pendingApprovalAtom,
  type HoliSummary,
} from './state'
import { EmptyState } from '@/composites/empty-state'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/composites/icon-button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DEFAULT_HOLI_COLOUR, type HabitSummary } from '@holi/shared'
import { habitsCap } from './habits-cap'

const AUTOMATIONS = 'automations'

const nextLabel = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** The automations this Holi carries out, after MonoCode's habits list: each
 *  opens in the Automations view, and + starts one already set to this Holi. */
function Habits({ holi }: { holi: HoliSummary }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const epoch = useAtomValue(holisEpochAtom)
  const select = useSetAtom(agentsSelectionAtom)
  const has = useHasCapability('schedules.list')
  const [habits, setHabits] = useState<HabitSummary[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (remote === null || !has) return
    let gone = false
    setError(false)
    void habitsCap.list(remote).then(
      (all) => {
        if (!gone) setHabits(all.filter((h) => h.holi === holi.id))
      },
      () => {
        if (!gone) setError(true)
      },
    )
    return () => {
      gone = true
    }
  }, [remote, has, holi.id, epoch, attempt])

  const newHabit = () => select({ owner: AUTOMATIONS, id: `new:${holi.id}` })

  if (!has) {
    return (
      <IconStackEmpty
        icon={Clock}
        title="Automations are off in this vault"
        description="Turn them on in Settings, Plugins, and give this Holi recurring work."
      />
    )
  }
  if (error) {
    return (
      <EmptyState
        role="alert"
        title="Could not read the automations"
        action={{ label: 'Retry', onClick: () => setAttempt((n) => n + 1) }}
      />
    )
  }
  if (habits === null) {
    return (
      <div role="status" aria-label="Loading habits" className="flex flex-col gap-2 p-6">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    )
  }
  if (habits.length === 0) {
    return (
      <IconStackEmpty
        icon={Clock}
        title="No habits yet"
        description={`Put recurring work on a schedule for ${holi.name}, like a morning digest or a weekly report.`}
        action={{ label: 'New habit', icon: Plus, onClick: newHabit }}
      />
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-4">
      {habits.map((h) => (
        <Button
          key={h.path}
          variant="ghost"
          className="h-auto w-full justify-start text-start font-normal hover:bg-foreground/5"
          onClick={() => select({ owner: AUTOMATIONS, id: h.path })}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
            <Clock className="size-3.5 text-muted-foreground" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">{h.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {h.error ??
                [
                  h.when,
                  h.nextRun === undefined ? null : `next ${nextLabel.format(new Date(h.nextRun))}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
            </span>
          </span>
          <Badge variant={h.status === 'on' ? 'primary-light' : 'outline'}>
            {h.status === 'on'
              ? 'Active'
              : h.status === 'changed'
                ? 'Changed'
                : h.status === 'invalid'
                  ? 'Invalid'
                  : 'Off'}
          </Badge>
        </Button>
      ))}
      <Button variant="ghost" size="sm" className="self-start" onClick={newHabit}>
        <Plus className="size-3.5" />
        New habit
      </Button>
    </div>
  )
}

export function HoliView({ id }: { id: string }): React.JSX.Element {
  const holis = useAtomValue(holisAtom)
  const loaded = useAtomValue(holisLoadedAtom)
  const reload = useSetAtom(loadHolisAtom)
  const state = useAtomValue(holiStateAtom)[id] ?? 'idle'
  const openSettings = useSetAtom(holiSettingsAtom)
  const approve = useSetAtom(pendingApprovalAtom)
  const holi = holis.find((h) => h.id === id)

  if (holi === undefined) {
    return loaded === 'loading' ? (
      <div role="status" aria-label="Loading" className="flex flex-col gap-3 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24" />
      </div>
    ) : loaded === 'error' ? (
      <EmptyState
        role="alert"
        title="Could not read the Holis"
        action={{ label: 'Retry', onClick: () => void reload() }}
      />
    ) : (
      <IconStackEmpty
        icon={Sparkles}
        title="That Holi is no longer in this vault"
        description="Someone removed or renamed its file. The others are in the sidebar."
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-holi-page={holi.id}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-divider pe-3 ps-4 text-sm">
        {holi.mascot !== undefined && (
          <PixelPersona
            name={holi.mascot}
            color={holi.color ?? DEFAULT_HOLI_COLOUR}
            status={state}
            crop="full"
          />
        )}
        <span className="truncate font-medium">{holi.name}</span>
        <span className="text-muted-foreground">
          {state === 'needs-you' ? 'Needs you' : state === 'working' ? 'Working' : 'Idle'}
        </span>
        <div className="ms-auto flex items-center gap-0.5">
          <IconButton
            label="Soul"
            size="icon-xs"
            onClick={() => openSettings({ id: holi.id, section: 'soul' })}
          >
            <Sparkles />
          </IconButton>
          <IconButton
            label="Memory"
            size="icon-xs"
            onClick={() => openSettings({ id: holi.id, section: 'memory' })}
          >
            <StickyNote />
          </IconButton>
          <IconButton
            label="Settings"
            size="icon-xs"
            onClick={() => openSettings({ id: holi.id, section: 'general' })}
          >
            <Settings />
          </IconButton>
        </div>
      </div>

      {(holi.status === 'new' || holi.status === 'changed' || holi.status === 'invalid') && (
        <div
          role={holi.status === 'invalid' ? 'alert' : undefined}
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider px-4 py-2.5 text-sm"
        >
          <span className="min-w-0 flex-1 text-muted-foreground">
            {holi.status === 'invalid'
              ? `It does not read: ${holi.error ?? 'unknown error'}`
              : holi.status === 'changed'
                ? 'Its soul or rules changed since this machine approved it. Sends wait until you look again.'
                : 'Not approved on this machine yet. Approve what it says now, and sends run without asking again.'}
          </span>
          {holi.status !== 'invalid' && (
            <Button size="xs" variant="secondary" onClick={() => approve({ holi })}>
              Review and approve
            </Button>
          )}
        </div>
      )}

      <Tabs defaultValue="runs" className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-divider px-4 py-2">
          <TabsList>
            <TabsTrigger value="runs">
              Runs
              {holi.runs.length > 0 && (
                <span className="tabular-nums text-muted-foreground">{holi.runs.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="habits">Habits</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="runs" className="flex min-h-0 flex-1 flex-col">
          <HoliFeed holi={holi} />
        </TabsContent>
        <TabsContent value="habits" className="flex min-h-0 flex-1 flex-col">
          <Habits holi={holi} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
