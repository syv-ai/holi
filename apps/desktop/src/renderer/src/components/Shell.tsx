/**
 * The app, once someone is signed in: a vault, its tree, and whatever tabs are
 * open over it.
 *
 * **Everything it used to listen to is gone.** `docs:event`, `vaults:event`,
 * `stream:resync`, `tasks:presence` and `reminders:open` all rode an SSE
 * connection to a server that no longer exists, and `vault.activate` became
 * `vaults.open` on the router. One snapshot push replaced all of them, and it
 * is subscribed once at the root — so this component listens to nothing and
 * reads atoms instead.
 *
 * The agent drawer (⌘J) mounts here as a right-hand sibling of the editor; the
 * history panel and daily notes are plan 7.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { History, PanelRight, Settings } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { fileKind, isTaskFilePath, isVaultConfigPath } from '@holi/shared'
import {
  Button,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Tooltip,
  type PanelImperativeHandle,
} from '@/primitives'
import { OnboardingRitual } from '@/features/onboarding/OnboardingRitual'
import { AgentPanel } from '@/features/agent/AgentPanel'
import { TurnReview } from '@/features/agent/TurnReview'
import { turnReviewOpenAtom } from '@/state/turns'
import { HistoryPanel } from '@/features/history/HistoryPanel'
import { BoardView } from '@/features/tasks/BoardView'
import { AgendaView } from '@/features/google/AgendaView'
import { MailView } from '@/features/google/MailView'
import { DialogHost } from './DialogHost'
import { FrontmatterFieldsHost } from '@/composites/FrontmatterFieldsHost'
import { PaneView } from './PaneView'
import { EditorPane } from '@/composites'
import { FilePlaceholder } from '@/features/files/FilePlaceholder'
import { AppFrame } from '@/features/apps/AppFrame'
import { AppsSection } from '@/features/apps/AppsSection'
import { FileTree } from '@/features/explorer/FileTree'
import { ImageViewer } from '@/features/files/ImageViewer'
import { VaultPicker } from '@/features/vault/VaultPicker'
import { syncLabel } from '../lib/sync-label'
import { saveAllBuffers } from '../lib/buffer-registry'
import { motionDurationMs, prefersReducedMotion } from '../lib/motion'
import { trpc } from '../lib/trpc'
import { openTodaysDailyAtom, sweepDailyAtom } from '../state/daily'
import { openLandingAtom } from '../state/landing'
import {
  activeTab,
  closePane,
  closeTab,
  closingTabRemovesPane,
  dropZones,
  focusPane,
  moveTab,
  moveTabToNewPane,
  openAgenda,
  openBoard,
  openHistory,
  openMail,
  openSettings,
  openPinned,
  openInNewPane,
  openPreview,
  pinActive,
  splitPane,
  pinTab,
  workspaceAtom,
  type Tab,
  type Workspace,
} from '../state/panes'
import { historyOpenAtom, historyTargetPathAtom } from '../state/history'
import { useGoogleAccount } from '../state/google'
import { openTaskCountAtom, tickNowAtom } from '../state/tasks'
import { openDialogAtom } from '../state/dialogs'
import type { PaneDropZone } from '@/lib/tab-drop'
import type { ConflictResolvers } from '@/lib/editor-reload'
import { ConflictBanner } from '@/composites/ConflictBanner'
import { SessionsSection } from '@/features/agent/SessionsSection'
import { VaultSwitchConfirm } from '@/features/agent/VaultSwitchConfirm'
import { agentModeAtSpawnAtom, agentPanelOpenAtom, agentSessionsAtom } from '@/state/agent'
import { reconcileAtom, showAgentPanelAtom } from '@/state/agent-send'
import { agentThemeNote, fleetIndicator, sessionsWorthAsking } from '@/lib/agent-notices'
import { activeModeAtom } from '@/state/color-scheme'

/** One shared empty array, so a pane not being dragged over keeps the same
 *  `allowed` reference between renders. */
const NO_ZONES: PaneDropZone[] = []
import { usePanelLayout } from '../state/preferences'
import { appsSectionOpenAtom, hasAppsAtom } from '../state/apps'
import { useVaultTheme } from '../state/theme'
import {
  activeRemoteAtom,
  heldBackAtom,
  openVaultAtom,
  abandonReconcileAtom,
  syncStateAtom,
  vaultsAtom,
} from '../state/vaults'

// quiet/busy map to semantic tokens; warn stays a named amber utility — there is
// no warning token yet, and named palette utilities are gate-legal (only arbitrary
// colour literals are banned).
/** The apps section's header row, in px — what the panel collapses TO, so the
 *  control that reopens the section does not vanish along with it. */
const APPS_HEADER_HEIGHT = 22

const TONE = { quiet: 'text-muted-foreground', busy: 'text-brand', warn: 'text-amber-400' } as const

/** Bytes as a short human size for the held-back callout (984 KB, 12.3 MB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function Shell() {
  const vaults = useAtomValue(vaultsAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const syncState = useAtomValue(syncStateAtom)
  const [workspace, setWorkspace] = useAtom(workspaceAtom)
  const setActiveRemote = useSetAtom(activeRemoteAtom)
  const openVault = useSetAtom(openVaultAtom)
  const openDaily = useSetAtom(openTodaysDailyAtom)
  const openLanding = useSetAtom(openLandingAtom)
  const sweepDaily = useSetAtom(sweepDailyAtom)
  const setHistoryOpen = useSetAtom(historyOpenAtom)
  const historyOpen = useAtomValue(historyOpenAtom)
  const turnReviewOpen = useAtomValue(turnReviewOpenAtom)
  const historyTarget = useAtomValue(historyTargetPathAtom)
  const openDialog = useSetAtom(openDialogAtom)
  const openTaskCount = useAtomValue(openTaskCountAtom)
  // Also the one place that asks main whether Google is connected at all — the
  // settings panel shares this atom rather than holding its own answer.
  const { account: googleAccount } = useGoogleAccount()
  const reconcile = useSetAtom(reconcileAtom)
  const abandonReconcile = useSetAtom(abandonReconcileAtom)
  const [heldBack, setHeldBack] = useAtom(heldBackAtom)
  /**
   * The pane on its way out of a split.
   *
   * React unmounts the instant state says the pane is gone, so an exit written
   * as a class on a pane that has already been removed never runs. The change is
   * held for exactly as long as the animation takes, read off `--motion-leave`
   * so the wait and the CSS cannot drift, and the pane is marked `leaving`
   * meanwhile. Under reduced motion there is nothing to wait for.
   *
   * **Both ways out of a split come through here.** The close-pane button is the
   * obvious one; closing the LAST TAB of a pane also unsplits, and that is the
   * one people actually do — an exit only the button played would look broken
   * more often than it looked right.
   */
  const [leavingPane, setLeavingPane] = useState<number | null>(null)
  const leaveTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current)
    },
    [],
  )

  const leaveThenApply = (index: number, apply: (w: Workspace) => Workspace): void => {
    if (prefersReducedMotion()) {
      setWorkspace(apply)
      return
    }
    // A second close before the first has landed: drop the outstanding timer
    // rather than letting two of them fire, which would take two panes for one
    // deliberate gesture.
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current)
    setLeavingPane(index)
    leaveTimer.current = window.setTimeout(
      () => {
        leaveTimer.current = null
        setWorkspace(apply)
        setLeavingPane(null)
      },
      motionDurationMs('--motion-leave', 190),
    )
  }

  const closePaneWithExit = (index: number): void =>
    leaveThenApply(index, (w) => closePane(w, index))

  const closeTabWithExit = (paneIndex: number, tabIndex: number): void => {
    const apply = (w: Workspace): Workspace => closeTab(focusPane(w, paneIndex), tabIndex)
    // Only the close that EMPTIES a pane is an exit. Every other tab close is
    // just a tab going, and holding those back by 190ms would make the strip
    // feel slow for the common case.
    if (closingTabRemovesPane(focusPane(workspace, paneIndex), tabIndex)) {
      leaveThenApply(paneIndex, apply)
      return
    }
    setWorkspace(apply)
  }

  const agentOpen = useAtomValue(agentPanelOpenAtom)
  /** Not a plain setter: opening the drawer onto a vault with no live session
   *  starts one, and that rule lives with the sessions (`showAgentPanelAtom`). */
  const showAgentPanel = useSetAtom(showAgentPanelAtom)
  // The footer's Claude control (#15) is the drawer's only affordance outside the
  // drawer. It reduces EVERY session to one dot (D100): needs-you outranks
  // working outranks a restart nudge, so the door is painted by whichever
  // session most wants you to open it.
  const agentSessions = useAtomValue(agentSessionsAtom)
  const agentModeAtSpawn = useAtomValue(agentModeAtSpawnAtom)
  const colorMode = useAtomValue(activeModeAtom)
  // One note for the set: the nudge is worth showing if ANY live session was
  // spawned under the mode the app has since moved off, and it says the same
  // sentence however many of them there are.
  const agentThemeNudge =
    agentSessions
      .filter((session) => !session.exited)
      .map((session) =>
        agentThemeNote({
          running: true,
          modeAtSpawn: agentModeAtSpawn[session.id] ?? null,
          mode: colorMode,
        }),
      )
      .find((note) => note !== null) ?? null
  const agentState = fleetIndicator(agentSessions, agentThemeNudge)
  const shellLayout = usePanelLayout(activeRemote, 'shell')
  // The sidebar's own vertical split: the tree above, the apps section below.
  const sidebarLayout = usePanelLayout(activeRemote, 'sidebar')
  const hasApps = useAtomValue(hasAppsAtom)
  const [appsOpen, setAppsOpen] = useAtom(appsSectionOpenAtom)
  /** Imperative handle on the apps panel, so `appsOpen` drives collapse/expand
   *  rather than the panel owning a second copy of that state. */
  const appsPanelRef = useRef<PanelImperativeHandle | null>(null)

  // Drive the panel from `appsOpen`, one frame late. The wait is not politeness:
  // the ref is attached before effects run, but the GROUP has not registered the
  // panel's constraints yet, and `isCollapsed()` throws `Panel constraints not
  // found` if you ask before it has — taking the whole Shell down with it. This
  // is the same `requestAnimationFrame` AgentPanel uses, for the same reason.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const panel = appsPanelRef.current
      if (!panel) return
      if (appsOpen && panel.isCollapsed()) panel.expand()
      else if (!appsOpen && !panel.isCollapsed()) panel.collapse()
    })
    return () => cancelAnimationFrame(id)
  }, [appsOpen, hasApps])
  // Paint the active vault's colour/chrome theme onto the document root.
  useVaultTheme()

  // Keep `nowAtom` on the current minute, so `overdue` turns over on the clock
  // rather than whenever something else happens to re-render. Every 30s and not
  // every 60: a minute-boundary crossing should show up within half a minute,
  // and the atom only changes identity when the minute string does, so the
  // extra tick costs nothing. Mounted here rather than at module scope, where
  // an interval would survive HMR and multiply.
  const tickNow = useSetAtom(tickNowAtom)
  useEffect(() => {
    const id = setInterval(() => tickNow(), 30_000)
    return () => clearInterval(id)
  }, [tickNow])
  /**
   * The tab currently being dragged, or null.
   *
   * It lives here because *which* drops are possible is a question about the
   * whole workspace, not about any one pane: an edge shared by two panes is one
   * gap, and whether landing in it changes anything depends on where the dragged
   * tab came from. `dropZones` answers that by asking the moves themselves.
   */
  const [dragTab, setDragTab] = useState<Tab | null>(null)
  /**
   * Whether the drag is currently over a tab strip.
   *
   * The landing strips stay out of sight while it is. Drawing them from the
   * moment a tab is picked up was deliberate (D78 — a target that materialises
   * once you reach it teaches nobody the gesture), but that reasoning predates
   * the strip previewing a reorder: the commonest drag by far never leaves the
   * strip at all, and lighting two bands under it for every nudge is noise. They
   * still appear *before* the pointer aims at one — the moment it leaves the
   * strip, which is the earliest a drag can be heading for a pane.
   */
  const [overStrip, setOverStrip] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  /** The vault a switch is waiting on an answer about, because sessions are
   *  running in the one being left (D100). */
  const [pendingVault, setPendingVault] = useState<string | null>(null)
  /** An unmergeable external write, with the two ways out the editor handed up.
   *  Held as one object so the message can never outlive its resolvers. */
  const [banner, setBanner] = useState<{
    path: string
    resolve: ConflictResolvers
  } | null>(null)
  /** The vault already opened in main, so a re-render — or `openVault` itself
   *  re-setting `activeRemoteAtom` to the same value — does not re-open it. */
  const openedRemote = useRef<string | null>(null)

  // Open the active vault in main, then land on whatever it opens on and sweep
  // prior days (FR-4/FR-5). One effect, once per remote, deliberately sequential.
  //
  // This is the ONLY caller of `vaults.open`, so cold start (the vault
  // `loadVaults` selects) and an explicit switch both open through here. The bug
  // this fixes: nothing opened the boot vault, so main's watcher never started
  // and the tree stayed empty until you manually switched.
  //
  // Landing runs *after* open for the same reason daily used to: it wins the
  // race for the active doc, and it reads the snapshot to tell a live target
  // from a rotted one, so it needs the vault already scanned. The sweep runs
  // last and reuses the settings landing just cached — the pair is one file
  // read, not two.
  useEffect(() => {
    if (!activeRemote || openedRemote.current === activeRemote) return
    openedRemote.current = activeRemote
    void (async () => {
      await openVault(activeRemote)
      await openLanding()
      await sweepDaily()
    })()
  }, [activeRemote, openVault, openLanding, sweepDaily])

  // FR-6: ⌘⇧D jumps to today's daily (creating it if needed). Deliberately NOT
  // routed through `openLanding` — this is the gesture that still works in a
  // vault whose `dailyNotes` is off, which is what makes "off" mean "stop doing
  // this behind my back" rather than "the feature is gone".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        void openDaily()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openDaily])

  // ⌘\ splits: a new empty pane beside this one, focused. Empty rather than a
  // copy of the current tab — see `splitPane`; one buffer per file is not a
  // preference, it is what the autosave/reload story rests on. The gesture that
  // opens something INTO a new pane is "open in a new pane", on the tree row and
  // the app row, which is the one people actually reach for.
  /**
   * ⌘S / Ctrl-S: save everything and commit, from anywhere in the window.
   *
   * It is a real commit point rather than a placebo (`prd/vaults-sync.md`
   * FR-4): write the buffers, then ask main to commit instead of waiting out
   * the idle timer, then push — ⌘S is an explicit "save this", so getting it
   * off-machine matches the intent (D61). The commit has to resolve before the
   * push, or the push races ahead of the edit ⌘S just committed.
   *
   * It lives here rather than in the editor because the board, a task's detail
   * and the agenda are all places where you have just changed something and
   * would press it. Every open buffer saves, not the focused one — a window
   * with two panes has two lots of work in it — and a buffer whose syntax is
   * mid-edit holds off on its own (FR-16), which is why this asks the registry
   * for the *gated* writer.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      void saveAllBuffers()
        .then(() => trpc.sync.commitNow.mutate())
        .then(() => trpc.sync.pushNow.mutate())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === '\\') {
        e.preventDefault()
        setWorkspace((w) => splitPane(w))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setWorkspace])

  // ⌘J (toggle the agent drawer) now lives on the drawer's own PanelHeader close
  // action — it owns its shortcut, and the panel stays mounted so it binds even
  // while collapsed. See features/agent/AgentPanel.tsx.

  // Create a task in any folder (including one that is not yet a lane, which board
  // quick-add cannot reach). ⌘T captures quickly and stays put; ⌘⇧T captures and
  // opens the detail editor to fill in the rest.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 't') return
      e.preventDefault()
      openDialog({ id: 'create-task', size: 'md', mode: e.shiftKey ? 'full' : 'quick' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openDialog])

  const tab = activeTab(workspace)
  // Every way a drag can end, including an escape-cancel and a drop that landed
  // somewhere with no handler at all. Without this the landing strips would stay
  // on screen for a drag that finished.
  useEffect(() => {
    if (dragTab === null) return
    const clear = () => {
      setDragTab(null)
      setOverStrip(false)
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [dragTab])

  const pane = workspace.panes[workspace.active]!

  // Feed the agent's per-turn hook the focused note — the one piece of state it
  // cannot discover itself (editor-UI focus). Main writes it to
  // `.holi/state/context.local.json`; a no-op when no session is running.
  useEffect(() => {
    const focusedPath = tab?.kind === 'note' ? tab.path : null
    const openPaths = pane.tabs.flatMap((t) => (t.kind === 'note' ? [t.path] : []))
    window.holi.agent.setFocus({ focusedPath, openPaths })
  }, [tab, pane])
  const label = syncLabel(syncState)
  // Single-click / link-nav opens a preview tab (browsing costs one tab);
  // double-click pins. Editing a preview promotes it (see EditorPane onEdit).
  const open = (path: string) => setWorkspace((w) => openPreview(w, path))
  const openPin = (path: string) => setWorkspace((w) => openPinned(w, path))

  /** A vault switch is a teardown in main — the old watcher and timers stop —
   *  so the tabs over the old vault have to go with it. Setting the active
   *  remote is all that is needed: the open effect above picks it up and runs
   *  the same open → daily → sweep sequence as cold start. */
  const applySwitch = (remote: string) => {
    setPendingVault(null)
    setWorkspace(() => ({ panes: [{ tabs: [], active: -1 }], active: 0 }))
    setBanner(null)
    setActiveRemote(remote)
  }

  /**
   * …and it ends every session in the vault, which is worth asking about first
   * (D100).
   *
   * The question has to be asked HERE, before `activeRemoteAtom` moves: the
   * effect above reacts to that atom by opening the new vault, which is what
   * closes the old one and takes its sessions with it. By the time the atom has
   * changed there is nothing left to confirm.
   */
  const switchVault = (remote: string) => {
    if (remote === activeRemote) return
    if (sessionsWorthAsking(agentSessions).length > 0) {
      setPendingVault(remote)
      return
    }
    applySwitch(remote)
  }

  // A conflict in the shared config files can leave the vault misconfigured while
  // it lasts, so it gets its own loud callout above the ordinary reconcile
  // affordance (vaults-sync.md §Edge cases). Ordinary content conflicts keep the
  // quiet footer button; only these get the banner.
  const configConflicts =
    syncState.kind === 'conflict' ? syncState.paths.filter(isVaultConfigPath) : []

  // Resolve a held-back file: commit it anyway, or keep it local. Drop it from
  // the list optimistically — main re-pushes the accurate set on its next tick.
  const resolveHeld = async (path: string, action: 'commit' | 'keep') => {
    if (activeRemote === null) return
    if (action === 'commit') await trpc.vaults.commitFile.mutate({ remote: activeRemote, path })
    else await trpc.vaults.keepFileLocal.mutate({ remote: activeRemote, path })
    setHeldBack((files) => files.filter((f) => f.path !== path))
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-w-0 flex-1"
          defaultLayout={shellLayout.defaultLayout}
          onLayoutChanged={(layout, meta) => {
            shellLayout.onLayoutChanged(layout, meta)
            // Reconcile a genuine handle drag of the agent panel back into its
            // `open` atom. Only `isUserInteraction` drags count: opening the
            // settings or history panel inserts a sibling and makes the library
            // recompute every size (isUserInteraction:false), which used to trip
            // the agent panel's own onResize into flipping open. The panel-level
            // callback can't tell a drag from a reflow; this one can.
            if (!meta.isUserInteraction) return
            showAgentPanel((layout.agent ?? 0) > 0)
          }}
        >
          <ResizablePanel id="nav" defaultSize={256} minSize={180} maxSize={440}>
            <aside className="relative flex h-full flex-col border-r border-divider">
              <div className="flex h-11 shrink-0 items-center px-2">
                <VaultPicker
                  vaults={vaults}
                  activeRemote={activeRemote}
                  onSelect={switchVault}
                  onAddVault={() => setShowAdd(true)}
                />
              </div>
              {showAdd && <OnboardingRitual mode="add-vault" onDismiss={() => setShowAdd(false)} />}
              {pendingVault !== null && (
                <VaultSwitchConfirm
                  onConfirm={() => applySwitch(pendingVault)}
                  onCancel={() => setPendingVault(null)}
                />
              )}

              {/* The tree and the apps list are two sections of one column with a
              draggable boundary between them — the sidebar's own vertical
              group, nested inside the workspace's horizontal one. The apps
              panel is absent rather than empty when the vault has no apps: a
              zero-content panel would still claim a slice and still draw a
              handle above it. */}
              <ResizablePanelGroup
                orientation="vertical"
                className="min-h-0 flex-1"
                defaultLayout={sidebarLayout.defaultLayout}
                onLayoutChanged={(layout, meta) => {
                  sidebarLayout.onLayoutChanged(layout, meta)
                  // Reconcile a real drag back into `appsOpen` — dragging the handle
                  // to the floor is the other way to collapse the section. Only
                  // `isUserInteraction`: mounting the panel, or the tree reflowing,
                  // reports every size with the flag false, and acting on that would
                  // collapse the section behind the user's back.
                  //
                  // Ask the PANEL whether it is collapsed rather than measuring
                  // `layout.apps`: a layout value is a flexGrow weight, not a pixel
                  // height, so comparing it against the collapsed height was a
                  // category error that read every expanded panel as collapsed.
                  if (!meta.isUserInteraction) return
                  setAppsOpen(appsPanelRef.current?.isCollapsed() === false)
                }}
              >
                <ResizablePanel id="tree" minSize={80}>
                  <FileTree
                    activePath={tab?.kind === 'note' ? tab.path : null}
                    onOpenPreview={open}
                    onOpenPinned={openPin}
                    onOpenInNewPane={(path) =>
                      setWorkspace((w) => openInNewPane(w, { kind: 'note', path }))
                    }
                  />
                </ResizablePanel>
                {hasApps && (
                  <>
                    <ResizableHandle />
                    <ResizablePanel
                      id="apps"
                      collapsible
                      // Collapsed leaves exactly the header row, which is the
                      // control that expands it again. Collapsing to 0 would take
                      // the section's own affordance away with it.
                      collapsedSize={APPS_HEADER_HEIGHT}
                      defaultSize={160}
                      minSize={66}
                      maxSize="60"
                      panelRef={appsPanelRef}
                    >
                      <AppsSection />
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>

              {/* Below the resizable group, not inside it: a session list is a
                  handful of rows, so it sizes to its contents and does not earn
                  a third handle in a column that already has one. It hides
                  itself when the vault has no sessions. */}
              <SessionsSection />

              {/* Two rows, not one. Chips across a sidebar this narrow made it scroll
              horizontally — and `flex-1` alone could not fix that, since a flex
              item's default `min-width: auto` refuses to shrink below its text.
              `min-w-0` on each chip is what actually forbids the overflow; the
              split is what keeps them legible rather than truncated. There is
              one fewer now: today's note is marked in the tree, where the file
              is, rather than behind a chip naming something you could not see. */}
              {/* `mt-auto` keeps the chips on the floor of the sidebar now that the
              tree no longer fills it — the spare height collects here, between
              the apps list and the chips, instead of above the apps list. */}
              <div className="mt-auto flex shrink-0 flex-col gap-1.5 p-2">
                <div className="flex items-center gap-2">
                  <Tooltip content={`task board — ${openTaskCount} open`}>
                    <Button
                      variant="secondary"
                      size="xs"
                      className="min-w-0 flex-1 gap-1.5"
                      onClick={() => setWorkspace((w) => openBoard(w))}
                    >
                      board
                      {openTaskCount > 0 && (
                        <span className="rounded-full bg-foreground/15 px-1.5 text-[10px] leading-4 text-foreground">
                          {openTaskCount}
                        </span>
                      )}
                    </Button>
                  </Tooltip>
                  {/* The gear opens the SETTINGS TAB, which is what a gear is
                      taken to mean. What it used to open — identity, members,
                      visibility — is not a preference and keeps its own
                      read-only panel, reachable from inside that tab. */}
                  <Tooltip content="settings">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 text-muted-foreground"
                      aria-label="settings"
                      onClick={() => setWorkspace((w) => openSettings(w))}
                    >
                      <Settings size={16} />
                    </Button>
                  </Tooltip>
                </div>

                {/* Agenda and mail are account-wide, not vault content (D67), and
                they appear only once Google is connected — a chip whose only
                destination is "connect Google in settings" is a dead end
                wearing the clothes of a feature. `undefined` (not asked yet)
                hides them too, so a disconnected app never flashes them. */}
                {googleAccount != null && (
                  <div className="flex items-center gap-2">
                    <Tooltip content={`${googleAccount.email} — agenda`}>
                      <Button
                        variant="secondary"
                        size="xs"
                        className="min-w-0 flex-1 gap-1.5"
                        onClick={() => setWorkspace((w) => openAgenda(w))}
                      >
                        agenda
                      </Button>
                    </Tooltip>
                    <Tooltip content={`${googleAccount.email} — mail`}>
                      <Button
                        variant="secondary"
                        size="xs"
                        className="min-w-0 flex-1 gap-1.5"
                        onClick={() => setWorkspace((w) => openMail(w))}
                      >
                        mail
                      </Button>
                    </Tooltip>
                  </div>
                )}
              </div>
            </aside>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel id="editor" minSize={360}>
            {/* The panes. One `ResizablePanelGroup` nested inside the editor
                slot, so the split resizes against itself and the sidebars, the
                history drawer and the agent panel are untouched by it.

                Its layout is deliberately NOT persisted (`usePanelLayout`): a
                stored layout is an array of weights keyed to a panel count, and
                the whole point of a pane is that it comes and goes. Restoring a
                two-pane split into a three-pane group is worse than starting
                even. */}
            <ResizablePanelGroup orientation="horizontal" className="min-h-0">
              {workspace.panes.map((p, i) => (
                <Fragment key={i}>
                  {i > 0 && <ResizableHandle />}
                  <ResizablePanel id={`pane-${i}`} minSize={240}>
                    <PaneView
                      pane={p}
                      focused={i === workspace.active}
                      leaving={leavingPane === i}
                      onFocus={() => setWorkspace((w) => focusPane(w, i))}
                      // Every action focuses this pane first, and then acts on
                      // "the active pane" — so the existing single-pane
                      // operations keep working unchanged, and clicking a tab in
                      // an unfocused pane moves you there, which is what
                      // clicking a tab means.
                      onSelect={(t) =>
                        setWorkspace((w) => {
                          const focusedW = focusPane(w, i)
                          return {
                            ...focusedW,
                            panes: focusedW.panes.map((q, pi) =>
                              pi === i ? { ...q, active: t } : q,
                            ),
                          }
                        })
                      }
                      onPin={(t) => setWorkspace((w) => pinTab(focusPane(w, i), t))}
                      onCloseTab={(t) => closeTabWithExit(i, t)}
                      onEdit={() => setWorkspace((w) => pinActive(focusPane(w, i)))}
                      onOpenNote={open}
                      onConflict={(path, resolve) => setBanner({ path, resolve })}
                      // A dropped tab carries only its identity, so neither of
                      // these needs to know where it came from — `moveTab`
                      // finds it, in whichever pane it currently sits.
                      // Which zones this pane may light up is a question about
                      // the whole workspace — pane 1's left edge and pane 0's
                      // right edge are one gap — so it is answered here, by the
                      // moves themselves, rather than guessed at per pane.
                      allowed={
                        dragTab === null || overStrip ? NO_ZONES : dropZones(workspace, dragTab, i)
                      }
                      // The pointer is on this strip when a drag starts from it,
                      // so say so here rather than waiting for the first
                      // `dragover` — otherwise the bands flash for one frame at
                      // the start of every drag.
                      onDragBegin={(tab) => {
                        setDragTab(tab)
                        setOverStrip(true)
                      }}
                      onDragOverStrip={setOverStrip}
                      onDropTab={(t, index) =>
                        setWorkspace((w) => moveTab(w, t, { pane: i, index }))
                      }
                      onDropEdge={(t, side) =>
                        setWorkspace((w) => moveTabToNewPane(w, t, side === 'before' ? i : i + 1))
                      }
                      trailing={
                        <>
                          {/* Version history for the focused note — a header
                              button toggling the right-hand drawer.
                              `historyTargetPathAtom` reads the ACTIVE pane's tab
                              and is the same predicate the drawer uses, so the
                              button belongs to that pane and nowhere else. */}
                          {i === workspace.active && historyTarget !== null && (
                            <Tooltip content="version history">
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="ml-1 shrink-0 text-muted-foreground"
                                onClick={() => setHistoryOpen((v) => !v)}
                              >
                                <History size={16} />
                              </Button>
                            </Tooltip>
                          )}
                          {/* Closing tabs one by one already unsplits (the last
                              one takes the pane with it); this is the same thing
                              in one gesture, for a pane holding ten of them. */}
                          {workspace.panes.length > 1 && (
                            <Tooltip content="close this pane">
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="ml-1 shrink-0 text-muted-foreground"
                                aria-label="close this pane"
                                onClick={() => closePaneWithExit(i)}
                              >
                                <PanelRight size={16} />
                              </Button>
                            </Tooltip>
                          )}
                        </>
                      }
                    />
                  </ResizablePanel>
                </Fragment>
              ))}
            </ResizablePanelGroup>
          </ResizablePanel>

          {historyOpen && historyTarget !== null && (
            <>
              <ResizableHandle />
              <ResizablePanel id="history" defaultSize={384} minSize={220}>
                <HistoryPanel />
              </ResizablePanel>
            </>
          )}

          {/* What the assistant's last turn changed (D88). A sibling of history
              because it is the same kind of reading — a diff over a commit
              range rather than over one commit. It renders nothing unless the
              footer chip has something to open. */}
          {turnReviewOpen && (
            <>
              <ResizableHandle />
              <ResizablePanel id="turn-review" defaultSize={384} minSize={220}>
                <TurnReview />
              </ResizablePanel>
            </>
          )}

          {/* The agent drawer is now a first-class member of the row: always
              mounted (its PTY + scrollback survive), collapsed to nothing when
              closed, drag-resizable against the editor like every other panel.
              ⌘J drives its collapse/expand from inside the component. */}
          <ResizableHandle />
          <AgentPanel />
        </ResizablePanelGroup>

        <DialogHost />

        {/* Every open frontmatter block's controls, portalled into the
            CodeMirror widgets that asked for them. Mounted here rather than in
            EditorPane because a widget does not know which pane it is in, and
            because one host means one subscription however many editors are
            open. */}
        <FrontmatterFieldsHost />
      </div>

      {/* A config conflict outranks everything else in the footer region: it is
          destructive-toned, names the offending file(s), and carries its own
          reconcile action, so a misconfigured vault can't hide behind the quiet
          footer button (vaults-sync.md §Edge cases / FR-18). */}
      {configConflicts.length > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <p className="min-w-0">
            <span className="font-semibold">Configuration conflict.</span>{' '}
            {configConflicts.map((p, i) => (
              <span key={p}>
                {i > 0 && (i === configConflicts.length - 1 ? ' and ' : ', ')}
                <code className="rounded bg-destructive/15 px-1 font-mono">{p}</code>
              </span>
            ))}{' '}
            {configConflicts.length === 1 ? 'is' : 'are'} unresolved — your vault may be
            misconfigured until you reconcile.
          </p>
          <Tooltip content="Re-run the merge and hand the conflict to the vault assistant to resolve">
            <Button
              variant="destructive"
              size="xs"
              className="shrink-0"
              onClick={() => void reconcile()}
            >
              Ask Claude to reconcile
            </Button>
          </Tooltip>
        </div>
      )}

      {/* The large-file gate (vaults-sync.md §Edge cases): files over the size
          cap are held out of git so they can't bloat every clone permanently.
          Amber, not destructive — nothing is wrong, there is just a decision to
          make. Each file offers commit-anyway or keep-local. */}
      {heldBack.length > 0 && (
        <div className="border-t border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          <p className="mb-1.5">
            <span className="font-semibold">
              {heldBack.length} file{heldBack.length === 1 ? '' : 's'} held back
            </span>{' '}
            — over the size limit, kept out of git so they don&rsquo;t bloat every clone.
          </p>
          <ul className="space-y-1">
            {heldBack.map((f) => (
              <li key={f.path} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-amber-900/30 px-1 font-mono">
                  {f.path}
                </code>
                <span className="shrink-0 text-amber-300/70">{formatBytes(f.bytes)}</span>
                <Button
                  variant="outline"
                  size="xs"
                  className="shrink-0"
                  onClick={() => void resolveHeld(f.path, 'commit')}
                >
                  Commit anyway
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="shrink-0"
                  onClick={() => void resolveHeld(f.path, 'keep')}
                >
                  Keep local
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The reconcile banner sits above the footer, beside the sync state it
          qualifies — an unmergeable external write to the open note raises it
          (EditorPane's onConflict), the one thing left that a user must answer. */}
      {banner !== null && (
        <ConflictBanner
          path={banner.path}
          resolve={banner.resolve}
          onDismiss={() => setBanner(null)}
        />
      )}

      {/* Sync state lives bottom-left: "where am I and is it saved elsewhere" is
          one glance. There is no Push button — push is automatic (D61) — so the
          footer only reports; sign out lives in settings. */}
      <footer className="flex items-center justify-between gap-3 border-t border-divider px-3 py-1 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          {/* The sync state doubles as the entry to the whole-vault commit history
              (comment: "clickable — up to date opens version control"). */}
          <Tooltip content="version history">
            <Button
              variant="link"
              // Button's own `text-sm font-medium` would otherwise outrank the
              // footer's `text-xs`, so the one word in the strip that changes
              // sat a size and a weight above everything around it.
              className={`h-auto p-0 text-xs font-normal truncate ${TONE[label.tone]}`}
              onClick={() => setWorkspace(openHistory)}
            >
              {label.text}
            </Button>
          </Tooltip>
          {/* The quiet footer affordance is for ordinary content conflicts; when a
              config file is among them the loud banner above owns the action, so
              this would be a redundant second reconcile button. */}
          {/* FR-20: while a reconcile runs, the one thing to offer is the way
              out of it. The files it is resolving are read-only (FR-19), so
              without this the only escape is a terminal. */}
          {syncState.kind === 'reconciling' && (
            <Tooltip content="Take the merge back out of the tree — the conflict stays, nothing is lost">
              <Button
                variant="outline"
                size="xs"
                className="shrink-0 border-amber-700/60 text-[11px] text-amber-300 hover:bg-amber-950/40 hover:text-amber-300"
                onClick={() => void abandonReconcile()}
              >
                Abandon
              </Button>
            </Tooltip>
          )}
          {syncState.kind === 'conflict' && configConflicts.length === 0 && (
            <Tooltip content="Re-run the merge and hand the conflict to the vault assistant to resolve">
              <Button
                variant="outline"
                size="xs"
                // amber = the warning role (no token yet); named utilities are gate-legal.
                className="shrink-0 border-amber-700/60 text-[11px] text-amber-300 hover:bg-amber-950/40 hover:text-amber-300"
                onClick={() => void reconcile()}
              >
                Ask Claude to reconcile
              </Button>
            </Tooltip>
          )}
        </div>
        {/* The vault assistant's only door outside itself (#15). ⌘J used to be
            the sole way in, and a live session was invisible once the drawer was
            closed; this is both the door and the light. Same derivation as the
            panel header, so the two cannot say different things.

            It has this corner to itself. The vault's remote and the signed-in
            login used to sit here, and neither was worth a permanent line: the
            vault is named in the sidebar header you are already looking at, and
            the login is in settings, where you go to change it. */}
        <Tooltip content={`${agentState.title} (⌘J)`}>
          <Button
            variant="link"
            aria-pressed={agentOpen}
            className="h-auto shrink-0 gap-1.5 p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
            onClick={() => showAgentPanel()}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${agentState.dot}`} />
            Claude
          </Button>
        </Tooltip>
      </footer>
    </div>
  )
}
