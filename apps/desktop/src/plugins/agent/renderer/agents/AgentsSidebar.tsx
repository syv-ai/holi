/**
 * The Agents mode's sidebar (docs/features/agent-sessions.md, The Agents
 * view): New session, the vault's scheduled Holis, its Holis, then the live
 * background sessions
 * grouped by what they need from you (Needs you, Working, Idle), then what
 * other plugins add (their slots), in the order they run.
 *
 * The rows are after MonoCode's sidebar (MIT, Copyright (c) 2026 Nick; see
 * NOTICE.md): a title, and under it the state in words with its own motion (a
 * turning loader while working, a steady amber while it waits on you). A Holi is its
 * pixel mascot, which bobs idle, hops while working and gets an idea when it
 * needs you. A Holi's runs are its own: their sessions show on its page, not
 * again here.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Ellipsis, Plus, SquarePen } from 'lucide-react'
import { SectionLabel } from '@/composites'
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Kbd,
} from '@/primitives'
import { agentsSlotsAtom, appModeAtom, cn, openPathAtom } from '@/plugin-api'
import { agentsViewAtom } from '../state/agents-view'
import {
  holiJobIdsAtom,
  holiStateAtom,
  holisAtom,
  holisLoadedAtom,
  loadHolisAtom,
  newHoliAtom,
  type HoliSummary,
} from '../state/holis'
import { agentSessionsAtom, type AgentSession } from '../state/sessions'
import { duplicateSessionAtom, respawnSessionAtom, stopSessionAtom } from '../state/send'
import { newViewSessionAtom } from '../state/session-view'
import { StateLabel } from './parts'
import { PixelMascot } from './PixelMascot'

/** The chrome row (`docs/ui-system.md`, Rules): one fill scale on the
 *  foreground, `text-nav`. */
const ROW =
  'h-7 w-full min-w-0 justify-start gap-2 rounded-lg px-2 text-nav font-medium text-muted-foreground motion-respond hover:bg-foreground/[0.04] hover:text-foreground active:bg-foreground/[0.07] aria-[current=page]:bg-foreground/[0.06] aria-[current=page]:text-foreground'

/** A session row: two lines, the same fill scale. */
const SESSION_ROW =
  'h-auto w-full min-w-0 flex-col items-stretch gap-0.5 rounded-lg px-2 py-1.5 text-start font-normal motion-respond hover:bg-foreground/[0.04] active:bg-foreground/[0.07] aria-[current=page]:bg-foreground/[0.06]'

function Group({
  label,
  count,
  children,
}: {
  label: string
  count: number
  children: React.ReactNode
}): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <section aria-label={label} className="flex flex-col gap-px">
      <SectionLabel className="flex items-center gap-1.5">
        {label}
        <span className="tabular-nums text-muted-foreground">{count}</span>
      </SectionLabel>
      {children}
    </section>
  )
}

/** A live background session, shown in its terminal. */
function SessionRow({ session }: { session: AgentSession }): React.JSX.Element {
  const view = useAtomValue(agentsViewAtom)
  const setView = useSetAtom(agentsViewAtom)
  const stop = useSetAtom(stopSessionAtom)
  const respawn = useSetAtom(respawnSessionAtom)
  const duplicate = useSetAtom(duplicateSessionAtom)
  const current = view.kind === 'session' && view.id === session.id
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          variant="ghost"
          className={SESSION_ROW}
          aria-current={current ? 'page' : undefined}
          data-session-row={session.id}
          data-state={session.state}
          onClick={() => setView({ kind: 'session', id: session.id })}
        >
          <span
            className={cn(
              'min-w-0 truncate text-nav font-medium',
              current ? 'text-foreground' : 'text-foreground/85',
            )}
          >
            {session.name}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StateLabel state={session.state} />
            {session.state === 'needs-you' && session.waitingFor !== undefined && (
              <span className="min-w-0 truncate">{session.waitingFor}</span>
            )}
            {session.state === 'idle' && <span>Idle</span>}
          </span>
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuItem onSelect={() => void respawn(session.id)}>Restart</ContextMenuItem>
        <ContextMenuItem onSelect={() => void duplicate(session.id)}>Duplicate</ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => void stop(session.id)}>
          Stop session
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function HoliRow({ holi }: { holi: HoliSummary }): React.JSX.Element {
  const view = useAtomValue(agentsViewAtom)
  const setView = useSetAtom(agentsViewAtom)
  const setMode = useSetAtom(appModeAtom)
  const openPath = useSetAtom(openPathAtom)
  const state = useAtomValue(holiStateAtom)[holi.id] ?? 'idle'
  const current = view.kind === 'holi' && view.id === holi.id
  const name = holi.name
  const broken = holi.status === 'invalid'
  return (
    <div className="group/holi relative">
      <Button
        variant="ghost"
        className={cn(ROW, 'h-8 pe-8')}
        aria-current={current ? 'page' : undefined}
        data-holi-row={holi.id}
        aria-label={`${name}${state === 'needs-you' ? ', needs you' : state === 'working' ? ', working' : ''}`}
        onClick={() => setView({ kind: 'holi', id: holi.id })}
      >
        <span className="relative flex size-[18px] shrink-0 items-center justify-center">
          {broken ? (
            <PixelMascot name="ghost" color="#8f8f94" still />
          ) : (
            <PixelMascot
              name={holi.mascot ?? 'ghost'}
              color={holi.color ?? '#8f8f94'}
              status={state}
            />
          )}
          <span
            aria-hidden="true"
            className={cn(
              'absolute -end-0.5 -top-0.5 size-[7px] rounded-full ring-2 ring-ground',
              state === 'needs-you'
                ? 'bg-amber-600 dark:bg-amber-400'
                : state === 'working'
                  ? 'motion-pulse bg-foreground'
                  : holi.status === 'approved'
                    ? 'bg-emerald-600 dark:bg-emerald-400'
                    : 'bg-muted-foreground/50',
            )}
          />
        </span>
        <span
          className={cn('min-w-0 flex-1 truncate text-start', broken && 'text-muted-foreground')}
        >
          {name}
        </span>
        <span className="shrink-0 truncate text-xs font-normal text-muted-foreground group-hover/holi:invisible group-focus-within/holi:invisible">
          {broken
            ? 'Invalid'
            : holi.kind === 'scheduled'
              ? (holi.when ?? 'Scheduled')
              : holi.status === 'changed'
                ? 'Changed'
                : holi.status === 'new'
                  ? 'New'
                  : holi.runs.length === 0
                    ? ''
                    : `${holi.runs.length} ${holi.runs.length === 1 ? 'run' : 'runs'}`}
        </span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            icon={Ellipsis}
            label={`${name} options`}
            size="sm"
            className="absolute end-1 top-1 opacity-0 group-hover/holi:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setView({ kind: 'holi', id: holi.id })}>
            Open
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setMode('documents')
              void openPath(holi.path)
            }}
          >
            Edit its file
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function HolisSection({
  label,
  holis,
  empty,
}: {
  label: string
  holis: readonly HoliSummary[]
  empty?: React.ReactNode
}): React.JSX.Element | null {
  const loaded = useAtomValue(holisLoadedAtom)
  const reload = useSetAtom(loadHolisAtom)
  const newHoli = useSetAtom(newHoliAtom)
  if (holis.length === 0 && empty === undefined) return null
  return (
    <section aria-label={label} className="flex flex-col gap-px">
      <div className="flex items-center justify-between pe-1">
        <SectionLabel className="pb-0">{label}</SectionLabel>
        {empty !== undefined && (
          <IconButton icon={Plus} label="New Holi" size="sm" onClick={() => newHoli({})} />
        )}
      </div>
      {loaded === 'loading' && holis.length === 0 ? (
        <div role="status" aria-label="Loading Holis" className="flex flex-col gap-1 px-2">
          <div className="h-6 rounded-lg motion-shimmer" />
          <div className="h-6 rounded-lg motion-shimmer" />
        </div>
      ) : loaded === 'error' ? (
        <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
          Could not read the Holis.
          <Button size="xs" variant="secondary" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
      ) : holis.length === 0 ? (
        empty
      ) : (
        holis.map((h) => <HoliRow key={h.id} holi={h} />)
      )}
    </section>
  )
}

function Holis(): React.JSX.Element {
  const holis = useAtomValue(holisAtom)
  const newHoli = useSetAtom(newHoliAtom)
  return (
    <>
      <HolisSection label="Scheduled Holis" holis={holis.filter((h) => h.kind === 'scheduled')} />
      <HolisSection
        label="Holis"
        holis={holis.filter((h) => h.kind === 'triggered')}
        empty={
          <Button variant="ghost" className={cn(ROW, 'font-normal')} onClick={() => newHoli({})}>
            <Icon icon={Plus} size="sm" />
            <span className="truncate">Make a Holi for this vault</span>
          </Button>
        }
      />
    </>
  )
}

export function AgentsSidebar(): React.JSX.Element {
  const all = useAtomValue(agentSessionsAtom)
  const runs = useAtomValue(holiJobIdsAtom)
  const view = useAtomValue(agentsViewAtom)
  const slots = useAtomValue(agentsSlotsAtom)
  const newSession = useSetAtom(newViewSessionAtom)
  const sessions = all.filter((s) => !runs.has(s.id))
  const needs = sessions.filter((s) => s.state === 'needs-you')
  const working = sessions.filter((s) => s.state === 'working')
  const idle = sessions.filter((s) => s.state === 'idle')

  return (
    <nav
      aria-label="Agents"
      // Groups spaced by the column's gap, as in Documents: section labels
      // carry no top padding of their own.
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2"
      data-agents-sidebar=""
    >
      <Button
        variant="ghost"
        className={ROW}
        aria-current={view.kind === 'home' ? 'page' : undefined}
        onClick={() => void newSession()}
      >
        <Icon icon={SquarePen} size="sm" />
        <span className="min-w-0 flex-1 truncate text-start">New session</span>
        <Kbd>⌘N</Kbd>
      </Button>

      <Holis />

      <Group label="Needs you" count={needs.length}>
        {needs.map((s) => (
          <SessionRow key={s.id} session={s} />
        ))}
      </Group>
      <Group label="Working" count={working.length}>
        {working.map((s) => (
          <SessionRow key={s.id} session={s} />
        ))}
      </Group>
      <Group label="Idle" count={idle.length}>
        {idle.map((s) => (
          <SessionRow key={s.id} session={s} />
        ))}
      </Group>
      {sessions.length === 0 && (
        <p className="px-2 pt-5 text-xs text-muted-foreground">
          No sessions are running. Start one with New session; it runs in the background and waits
          here while it works.
        </p>
      )}

      {slots.map((slot) =>
        slot.sidebar === undefined ? null : <slot.sidebar key={slot.plugin} />,
      )}
    </nav>
  )
}
