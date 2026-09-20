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
import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, ResizablePanel, Tooltip, type PanelImperativeHandle } from '@/primitives'
import { PanelHeader } from '@/composites'
import { cn } from '@/lib/cn'
import { DEFAULT_AGENT_PANEL_WIDTH, MIN_AGENT_PANEL_WIDTH } from '@/lib/agent-panel-geometry'
import { agentIndicator, agentThemeNote } from '@/lib/agent-notices'
import {
  activeSessionAtom,
  activeSessionIdAtom,
  agentGeometryAtom,
  agentModeAtSpawnAtom,
  agentPanelOpenAtom,
  agentSessionsAtom,
  type AgentSession,
} from '@/state/agent'
import { showAgentPanelAtom, startSessionAtom } from '@/state/agent-send'
import { activeModeAtom } from '@/state/color-scheme'
import { resetTurnReviewAtom, turnReviewOpenAtom } from '@/state/turns'
import { activeRemoteAtom } from '@/state/vaults'
import { SessionTerminal } from './SessionTerminal'
import { TurnChip } from './TurnChip'

export function AgentPanel() {
  const open = useAtomValue(agentPanelOpenAtom)
  const showPanel = useSetAtom(showAgentPanelAtom)
  const [sessions, setSessions] = useAtom(agentSessionsAtom)
  const active = useAtomValue(activeSessionAtom)
  const setActiveId = useSetAtom(activeSessionIdAtom)
  // A vault's identity is its remote (D60). The panel no longer passes it to a
  // start — `startSessionAtom` reads it — but it is still what a vault SWITCH
  // looks like from here, which the turn review below reacts to.
  const activeRemote = useAtomValue(activeRemoteAtom)
  const startSession = useSetAtom(startSessionAtom)
  const setGeometry = useSetAtom(agentGeometryAtom)
  const mode = useAtomValue(activeModeAtom)
  const [modeAtSpawn, setModeAtSpawn] = useAtom(agentModeAtSpawnAtom)
  const resetTurnReview = useSetAtom(resetTurnReviewAtom)
  const setTurnReviewOpen = useSetAtom(turnReviewOpenAtom)
  /** Imperative handle on the collapsible group panel — driven by `open` (below),
   *  so ⌘J and the reconcile trigger expand/collapse the panel instead of a bespoke
   *  width. The panel stays mounted while collapsed, so the PTYs + scrollback live on. */
  const panelRef = useRef<PanelImperativeHandle | null>(null)
  /** The session a close is waiting on confirmation for. */
  const [confirming, setConfirming] = useState<AgentSession | null>(null)

  // The list is pushed, and asked for once on mount: the drawer's dot has to be
  // right before the drawer has ever been opened, and a renderer reload lands
  // after every push this vault's sessions have made.
  useEffect(() => {
    // A push that lands while the mount-time question is in flight is NEWER than
    // its answer, and letting the answer win would drop a tab whose terminal is
    // already mounted, taking its xterm with it.
    let pushed = false
    const off = window.holi.agent.onSessions((list) => {
      pushed = true
      setSessions(list)
    })
    void window.holi.agent.sessions().then((list) => {
      if (!pushed) setSessions(list)
    })
    return off
  }, [setSessions])

  /**
   * A vault switch clears the turn review.
   *
   * The record is per vault and this panel outlives the switch, so without this
   * the review stays open on the previous vault's turn — and every query it
   * makes asks the NEW vault's git for a range it has never heard of. The panel
   * is the always-mounted owner of that lifecycle now that the chip is per tab
   * and the chip that used to own it can be absent.
   *
   * The edge and not the level: on mount there is nothing to clear, and clearing
   * anyway would throw away a record that has just been loaded.
   */
  const lastRemote = useRef(activeRemote)
  useEffect(() => {
    if (lastRemote.current === activeRemote) return
    lastRemote.current = activeRemote
    resetTurnReview()
    setTurnReviewOpen(false)
  }, [activeRemote, resetTurnReview, setTurnReviewOpen])

  /** A session that has left the list takes its spawn-time colour mode with it.
   *  The map is keyed by session id and nothing else prunes it. */
  useEffect(() => {
    setModeAtSpawn((byId) => {
      const live = new Set(sessions.map((s) => s.id))
      const kept = Object.entries(byId).filter(([id]) => live.has(id))
      // Same object when nothing went, so this cannot loop on its own write.
      return kept.length === Object.keys(byId).length ? byId : Object.fromEntries(kept)
    })
  }, [sessions, setModeAtSpawn])

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
   * Restart ends the tab you are looking at and starts another.
   *
   * With ids that is genuinely a NEW session rather than the same one reborn, so
   * it gets a new tab. Saying otherwise would mean pretending a conversation
   * survived that did not. It touches no other tab.
   */
  const restart = async () => {
    if (active !== null) await window.holi.agent.kill(active.id)
    await startSession()
  }

  /**
   * History opens `--resume` in a new tab and **kills nothing**.
   *
   * It used to kill first because there was one slot to resume into. There is
   * not any more, and ending a live conversation to go and look at an old one is
   * a cost the design does not ask anybody to pay. Bare `--resume`: the CLI
   * shows its own picker in the new tab.
   */
  const history = async () => {
    await startSession({ resume: true })
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
              label: 'Resume a past session in a new tab',
              onSelect: () => void history(),
            },
            {
              icon: <RotateCw />,
              label: 'Restart this session',
              onSelect: () => void restart(),
            },
          ]}
          close={{
            icon: <X />,
            label: 'Hide agent panel',
            hotkey: '⌘J',
            onSelect: () => showPanel(),
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
            onGeometry={(cols, rows) => setGeometry({ cols, rows })}
          />
        ))}
        {sessions.length === 0 && <div className="min-h-0 flex-1 bg-background" />}

        {/* Under the terminal it belongs to, not in the footer. A turn belongs
            to a session, and one chip in the corner could not say which of
            three sessions had just finished one. */}
        {active !== null && (
          <div className="shrink-0 border-t border-divider px-2 py-1">
            {/* Keyed: its `wasWorking` and `acked` refs are about ONE session,
                and carrying them to the next tab blooms for a turn that landed
                minutes ago. */}
            <TurnChip key={active.id} sessionId={active.id} />
          </div>
        )}
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
