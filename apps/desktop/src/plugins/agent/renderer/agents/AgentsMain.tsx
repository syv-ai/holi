/**
 * The Agents mode's main view (docs/features/agent-sessions.md, The Agents
 * view): one of four things, picked in the sidebar.
 *
 * - **Home**: what the view is for, with New session and Make a Holi.
 * - **A live background session**: its terminal, `claude attach`, since
 *   Claude Code's TUI is its interface.
 * - **A Holi**: what came of its runs (`HoliFeed`), its details beside them.
 * - **A row another plugin added**: that plugin's own view (its slot).
 *
 * After MonoCode's `SessionPane` (MIT, Copyright (c) 2026 Nick; see
 * NOTICE.md), cut to the mock's simplicity.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Bot, PanelRight, SquarePen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button, Icon, IconButton } from '@/primitives'
import { activeRemoteAtom, agentsSlotsAtom } from '@/plugin-api'
import { agentCap } from '../agent-cap'
import { SessionTerminal } from '../SessionTerminal'
import { agentsViewAtom, viewTerminalsAtom } from '../state/agents-view'
import { holiStateAtom, holisAtom, holisLoadedAtom, loadHolisAtom } from '../state/holis'
import { newViewSessionAtom } from '../state/session-view'
import { agentGeometryAtom, agentSessionsAtom } from '../state/sessions'
import { HoliDetails } from './HoliDetails'
import { HoliFeed } from './HoliFeed'
import { NewHoliDialog } from './NewHoliDialog'
import { StateLabel } from './parts'
import { PixelMascot } from './PixelMascot'

function Bar({
  children,
  end,
}: {
  children: React.ReactNode
  end?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-divider pe-3 ps-4 text-sm">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {end !== undefined && <div className="flex shrink-0 items-center gap-0.5">{end}</div>}
    </div>
  )
}

function Home(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const start = useSetAtom(newViewSessionAtom)
  const [making, setMaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const vault = remote?.split('/')[1] ?? 'this vault'
  return (
    <>
      <Bar>
        <span className="font-medium">Agents</span>
      </Bar>
      <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto p-8">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <h2 className="text-lg font-medium tracking-tight">The work being done in {vault}</h2>
          <p className="text-sm text-muted-foreground">
            A session is Claude Code in the background, in a terminal here. A Holi is an agent that
            belongs to the vault: send it a note from the note's Agent menu, and its page says what
            came of each run.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              size="sm"
              onClick={() => void start().then((res) => setError(res.ok ? null : res.message))}
            >
              <Icon icon={SquarePen} size="sm" />
              New session
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setMaking(true)}>
              <Icon icon={Bot} size="sm" />
              Make a Holi
            </Button>
          </div>
          {error !== null && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>
      {making && <NewHoliDialog onClose={() => setMaking(false)} />}
    </>
  )
}

function HoliPane({ id, run }: { id: string; run?: string }): React.JSX.Element {
  const holis = useAtomValue(holisAtom)
  const loaded = useAtomValue(holisLoadedAtom)
  const reload = useSetAtom(loadHolisAtom)
  const state = useAtomValue(holiStateAtom)[id] ?? 'idle'
  const [details, setDetails] = useState(true)
  const holi = holis.find((h) => h.id === id)

  if (holi === undefined) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        {loaded === 'loading' ? (
          <div role="status" aria-label="Loading" className="h-24 w-64 rounded-lg motion-shimmer" />
        ) : loaded === 'error' ? (
          <>
            Could not read the Holis.
            <Button size="xs" variant="secondary" onClick={() => void reload()}>
              Retry
            </Button>
          </>
        ) : (
          'That Holi is no longer in this vault.'
        )}
      </div>
    )
  }
  const name = holi.name
  return (
    <>
      <Bar
        end={
          <IconButton
            icon={PanelRight}
            label="Details"
            size="sm"
            pressed={details}
            onClick={() => setDetails((d) => !d)}
          />
        }
      >
        {holi.mascot !== undefined && (
          <PixelMascot name={holi.mascot} color={holi.color ?? '#8f8f94'} status={state} />
        )}
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground">
          {state === 'needs-you' ? 'Needs you' : state === 'working' ? 'Working' : 'Idle'}
        </span>
      </Bar>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <HoliFeed holi={holi} {...(run === undefined ? {} : { focus: run })} />
        </div>
        {details && <HoliDetails holi={holi} status={state} />}
      </div>
    </>
  )
}

/** A background session in a terminal of the view's own: the one its New
 *  session opened, or a new `claude attach` window that closes with the view. */
function TerminalView({ id }: { id: string }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const geometry = useAtomValue(agentGeometryAtom)
  const setGeometry = useSetAtom(agentGeometryAtom)
  const owned = useAtomValue(viewTerminalsAtom)[id]
  const setOwned = useSetAtom(viewTerminalsAtom)
  const session = sessions.find((s) => s.id === id)
  const [terminalId, setTerminalId] = useState<string | null>(owned ?? null)
  const [error, setError] = useState<string | null>(null)
  const opened = useRef<string | null>(owned ?? null)

  useEffect(() => {
    if (remote === null) return
    let gone = false
    if (opened.current === null) {
      void agentCap.open(remote, { attach: id, ...geometry }).then((res) => {
        if (gone) {
          if (res.ok) void agentCap.detach(remote, { id: res.terminalId })
          return
        }
        if (res.ok) {
          opened.current = res.terminalId
          setTerminalId(res.terminalId)
        } else setError(res.message)
      })
    }
    return () => {
      gone = true
      // The window closes with the view; the session goes on in the background.
      if (opened.current !== null) void agentCap.detach(remote, { id: opened.current })
      opened.current = null
      setOwned((t) => {
        const { [id]: _gone, ...rest } = t
        return rest
      })
    }
    // Opened once per session shown; the geometry is only where it starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, id])

  return (
    <>
      <Bar>
        <span className="truncate font-medium">{session?.name ?? 'Session'}</span>
        {session !== undefined && (
          <span className="flex shrink-0 items-center gap-2 text-xs">
            <StateLabel state={session.state} />
          </span>
        )}
      </Bar>
      <div className="flex min-h-0 flex-1 flex-col">
        {error !== null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-destructive">
            {error}
          </div>
        ) : terminalId === null ? (
          <div
            role="status"
            aria-label="Opening the terminal"
            className="m-6 h-24 rounded-lg motion-shimmer"
          />
        ) : (
          <SessionTerminal
            terminalId={terminalId}
            visible
            onGeometry={(cols, rows) => setGeometry({ cols, rows })}
          />
        )}
      </div>
    </>
  )
}

export function AgentsMain(): React.JSX.Element {
  const view = useAtomValue(agentsViewAtom)
  const setView = useSetAtom(agentsViewAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const slots = useAtomValue(agentsSlotsAtom)
  const slot = view.kind === 'slot' ? slots.find((s) => s.plugin === view.owner) : undefined

  // A session that stopped, or a plugin turned off, is no longer something to
  // show.
  const missing =
    (view.kind === 'session' && !sessions.some((s) => s.id === view.id)) ||
    (view.kind === 'slot' && slot?.main === undefined)
  useEffect(() => {
    if (missing) setView({ kind: 'home' })
  }, [missing, setView])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-agents-main={view.kind}>
      {view.kind === 'holi' ? (
        <HoliPane
          key={view.id}
          id={view.id}
          {...(view.run === undefined ? {} : { run: view.run })}
        />
      ) : view.kind === 'session' && !missing ? (
        <TerminalView key={view.id} id={view.id} />
      ) : view.kind === 'slot' && slot?.main !== undefined ? (
        <slot.main key={view.id} id={view.id} />
      ) : (
        <Home />
      )}
    </div>
  )
}
