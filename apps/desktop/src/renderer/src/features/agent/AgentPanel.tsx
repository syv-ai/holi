/**
 * The agent drawer: a tab per live session (D100), and the one showing.
 *
 * What used to be one terminal in a panel is now a strip and N `SessionTerminal`s,
 * all mounted, one visible. The panel owns everything that is about the SET —
 * which tab is active, starting one, ending one — and nothing about what is
 * inside a terminal, which is `SessionTerminal`'s.
 *
 * **The session list is main's**, pushed on `agent:sessions`. The panel never
 * derives it: a tab exists because a session does, an exited session keeps its
 * tab until someone closes it, and the name on a tab is Claude Code's own.
 */
import { History, Plus, RotateCw, X } from 'lucide-react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Dialog, ResizablePanel, Tooltip, type PanelImperativeHandle } from '@/primitives'
import { PanelHeader } from '@/composites'
import { cn } from '@/lib/cn'
import { DEFAULT_AGENT_PANEL_WIDTH, MIN_AGENT_PANEL_WIDTH } from '@/lib/agent-panel-geometry'
import { agentIndicator, agentThemeNote, type ColorMode } from '@/lib/agent-notices'
import {
  activeSessionAtom,
  activeSessionIdAtom,
  agentModeAtSpawnAtom,
  agentPanelOpenAtom,
  agentSeedPromptAtom,
  agentSessionsAtom,
  type AgentSession,
} from '@/state/agent'
import { activeModeAtom } from '@/state/color-scheme'
import { activeRemoteAtom } from '@/state/vaults'
import { SessionTerminal } from './SessionTerminal'

/** What a session is spawned at before any tab has been measured. xterm's own
 *  native default, so the first paint is never a resize-to-catch-up. */
const FALLBACK_GEOMETRY = { cols: 80, rows: 24 }

export function AgentPanel() {
  const [open, setOpen] = useAtom(agentPanelOpenAtom)
  const [sessions, setSessions] = useAtom(agentSessionsAtom)
  const active = useAtomValue(activeSessionAtom)
  const setActiveId = useSetAtom(activeSessionIdAtom)
  // A vault's identity is its remote (D60); it is the id the manager matches
  // against `host.active().remote`.
  const activeRemote = useAtomValue(activeRemoteAtom)
  const [seedPrompt, setSeedPrompt] = useAtom(agentSeedPromptAtom)
  const mode = useAtomValue(activeModeAtom)
  const [modeAtSpawn, setModeAtSpawn] = useAtom(agentModeAtSpawnAtom)
  /** …and a mirror of it for `startSession`, which must not take `mode` as a
   *  dependency: rebuilding that callback on a theme flip re-runs the effects
   *  that own auto-start. */
  const modeRef = useRef<ColorMode>(mode)
  modeRef.current = mode
  /** Imperative handle on the collapsible group panel — driven by `open` (below),
   *  so ⌘J and the reconcile trigger expand/collapse the panel instead of a bespoke
   *  width. The panel stays mounted while collapsed, so the PTYs + scrollback live on. */
  const panelRef = useRef<PanelImperativeHandle | null>(null)
  /** The last geometry any visible tab measured. A session started for a tab
   *  that has never been shown has none of its own. */
  const geometryRef = useRef(FALLBACK_GEOMETRY)
  /** The session a close is waiting on confirmation for. */
  const [confirming, setConfirming] = useState<AgentSession | null>(null)

  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const seedPromptRef = useRef<string | null>(seedPrompt)
  seedPromptRef.current = seedPrompt

  // The list is pushed, and asked for once on mount: the drawer's dot has to be
  // right before the drawer has ever been opened, and a renderer reload lands
  // after every push this vault's sessions have made.
  useEffect(() => {
    const off = window.holi.agent.onSessions(setSessions)
    void window.holi.agent.sessions().then(setSessions)
    return off
  }, [setSessions])

  const startSession = useCallback(
    async (opts: { resume?: boolean; prompt?: string } = {}): Promise<string | null> => {
      if (!activeRemote) return null
      const { cols, rows } = geometryRef.current
      const res = await window.holi.agent.start({
        vaultId: activeRemote,
        cols,
        rows,
        ...(opts.resume === undefined ? {} : { resume: opts.resume }),
        ...(opts.prompt === undefined ? {} : { prompt: opts.prompt }),
      })
      if (!res.ok || res.id === undefined) return null
      // Show it: someone who pressed + is asking to look at the new session, and
      // a reconcile's seeded turn is the thing they want to watch.
      setActiveId(res.id)
      // What Claude just read out of its settings, for this session alone.
      setModeAtSpawn((m) => ({ ...m, [res.id as string]: modeRef.current }))
      return res.id
    },
    [activeRemote, setActiveId, setModeAtSpawn],
  )

  /**
   * Opening the drawer starts a session when there is none.
   *
   * Keyed to the drawer OPENING, not to "the list is empty while it is open":
   * the second reading respawns instantly when you close the last tab, which
   * makes the close button look broken.
   */
  const wasOpen = useRef(open)
  useEffect(() => {
    const opening = open && !wasOpen.current
    wasOpen.current = open
    if (!opening) return
    // A reconcile seed is pending — the seed effect owns that start so the
    // prompt lands on turn one. Don't race it with a bare session.
    if (seedPromptRef.current !== null) return
    if (sessionsRef.current.some((s) => !s.exited)) return
    void startSession()
  }, [open, startSession])

  // Reconcile: the "Ask Claude to reconcile" button set a seed prompt (and opened
  // the drawer). It gets its OWN session rather than restarting one — the seed
  // cannot be injected into a conversation mid-flight, and with tabs there is no
  // longer a single slot it would have to displace. Then clear it.
  useEffect(() => {
    if (seedPrompt === null) return
    void (async () => {
      await startSession({ prompt: seedPrompt })
      setSeedPrompt(null)
    })()
  }, [seedPrompt, startSession, setSeedPrompt])

  // `open` is the source of truth; drive the panel to match. Deferred a frame:
  // the panel's imperative API throws "Group not found" if touched during the
  // mount commit (a child's effect runs before the parent Group has registered
  // itself), so rAF puts every collapse/expand safely after the group is live.
  // The panel mounts at its defaultSize, so the first frame collapses it closed.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const p = panelRef.current
      if (!p) return
      if (open && p.isCollapsed()) p.expand()
      else if (!open && !p.isCollapsed()) p.collapse()
    })
    return () => cancelAnimationFrame(id)
  }, [open])

  // A user drag of the handle reconciles back into `open` at the GROUP level
  // (Shell's onLayoutChanged), where the library reports `isUserInteraction`.
  // The panel-level onResize fires for programmatic reflows too — inserting the
  // settings/history panel recomputes every size — and can't tell them apart, so
  // reconciling here spuriously opened the drawer whenever a sibling panel
  // mounted. `open` stays the single source of truth; the effect above drives
  // the panel to match it.

  const noteFor = (session: AgentSession): string | null =>
    agentThemeNote({
      running: !session.exited,
      modeAtSpawn: modeAtSpawn[session.id] ?? null,
      mode,
    })

  const close = async (session: AgentSession) => {
    setConfirming(null)
    await window.holi.agent.kill(session.id)
  }

  /**
   * Restart, and resume, act on the tab you are looking at.
   *
   * Both end that session and start another, which with ids is genuinely a NEW
   * session rather than the same one reborn — so its tab is a new tab, at the
   * end of the strip. Saying otherwise would mean pretending a conversation
   * survived that did not. `--resume` is bare: the CLI shows its own picker.
   */
  const replace = async (resume: boolean) => {
    if (active !== null) await window.holi.agent.kill(active.id)
    await startSession({ resume })
  }

  return (
    <ResizablePanel
      id="agent"
      collapsible
      collapsedSize={0}
      defaultSize={DEFAULT_AGENT_PANEL_WIDTH}
      minSize={MIN_AGENT_PANEL_WIDTH}
      panelRef={panelRef}
    >
      {/* Kept `hidden` when closed so no terminal is ever built against a
          display:none host, and no stray content shows while the panel is a
          0-width sliver. The panel stays mounted either way. */}
      <aside
        className={cn('flex h-full min-w-0 flex-col border-l border-divider', !open && 'hidden')}
      >
        {/* The shared panel bar. It no longer carries a dot and a state word:
            with a tab per session those belong on the tabs, and one header
            reading "running" over three tabs in three different states was the
            duplicate-state problem D72 already named. What is left is the word
            and the actions, which act on the tab you are looking at. */}
        <PanelHeader
          actions={[
            {
              icon: <History />,
              label: 'Resume a past session in this tab',
              onSelect: () => void replace(true),
            },
            {
              icon: <RotateCw />,
              label: 'Restart this session',
              onSelect: () => void replace(false),
            },
          ]}
          close={{
            icon: <X />,
            label: 'Hide agent panel',
            hotkey: '⌘J',
            onSelect: () => setOpen((o) => !o),
          }}
        >
          <span className="text-foreground">Claude</span>
          {/* No login notice here, deliberately (D72), and D86 did not change that.
            A vault now needs its own `/login`, which is a genuinely new thing to
            say — but it is said in the SCROLLBACK, printed by main at spawn
            (`SIGN_IN_NOTICE`), for exactly the reason this comment already gave:
            `/login` fires none of the events that push state, so a copy in the
            header goes stale the moment it matters. */}
        </PanelHeader>

        {/* The strip. Scrolls sideways rather than wrapping: the drawer is
            narrow and a second row of tabs would eat the terminal. */}
        <div
          role="tablist"
          aria-label="agent sessions"
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-divider px-1 py-1"
        >
          {sessions.map((session) => {
            const indicator = agentIndicator({
              ...session,
              themeNote: noteFor(session),
            })
            const isActive = session.id === active?.id
            return (
              <span
                key={session.id}
                data-session-tab={session.id}
                className={cn(
                  'group flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs',
                  isActive
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Tooltip content={indicator.title}>
                  <Button
                    variant="ghost"
                    role="tab"
                    aria-selected={isActive}
                    className={cn(
                      'h-auto max-w-40 gap-1.5 p-0 text-xs font-normal hover:bg-transparent',
                      session.exited && 'opacity-60',
                    )}
                    onClick={() => setActiveId(session.id)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn('h-2 w-2 shrink-0 rounded-full', indicator.dot)}
                    />
                    <span className="truncate">{session.name}</span>
                  </Button>
                </Tooltip>
                {/* Hidden with `opacity`, never `hidden`: a control that came and
                    went with the pointer would change the tab's width and shift
                    every tab after it under the pointer that hovered it. */}
                <Tooltip content="end this session">
                  <Button
                    variant="ghost"
                    aria-label={`end ${session.name}`}
                    className="motion-respond h-auto p-0 opacity-0 group-hover:opacity-100 hover:bg-transparent focus-visible:opacity-100"
                    onClick={() => {
                      // Only a session that is doing something gets a question.
                      // An idle or exited one is a click, not a decision.
                      if (session.state === 'idle' || session.exited) void close(session)
                      else setConfirming(session)
                    }}
                  >
                    ✕
                  </Button>
                </Tooltip>
              </span>
            )
          })}
          <Tooltip content="start another session">
            <Button
              variant="ghost"
              aria-label="start another session"
              className="h-auto shrink-0 p-1 text-muted-foreground hover:text-foreground"
              onClick={() => void startSession()}
            >
              <Plus className="size-3.5" />
            </Button>
          </Tooltip>
        </div>

        {/* All of them, one visible. See `SessionTerminal` for why they stay
            mounted. */}
        {sessions.map((session) => (
          <SessionTerminal
            key={session.id}
            sessionId={session.id}
            visible={open && session.id === active?.id}
            onGeometry={(cols, rows) => (geometryRef.current = { cols, rows })}
          />
        ))}
        {sessions.length === 0 && <div className="min-h-0 flex-1 bg-background" />}
      </aside>

      {confirming !== null && (
        <Dialog open onClose={() => setConfirming(null)} size="sm">
          <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
            <Dialog.Header>End {confirming.name}?</Dialog.Header>
            <Dialog.Body>
              <p className="text-xs text-muted-foreground">
                {confirming.state === 'needs-you'
                  ? 'It is waiting for you to answer something. Ending it now drops the question and whatever it was about to do.'
                  : 'It is mid-turn. Ending it now stops the work part-way; what it has already written stays in the vault.'}
              </p>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void close(confirming)}>
                End session
              </Button>
            </Dialog.Footer>
          </div>
        </Dialog>
      )}
    </ResizablePanel>
  )
}
