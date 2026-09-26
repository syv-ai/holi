/**
 * The app, once someone is signed in: a vault, its tree, and whatever tabs are
 * open over it. The snapshot push is subscribed once at the root, so this reads
 * atoms. An agent session is an ordinary tab (D101).
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { History, PanelLeftClose, PanelLeftOpen, PanelRight, Settings } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { fileKind, isTaskFilePath, isVaultConfigPath } from '@holi/shared'
import {
  Button,
  Kbd,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Tooltip,
  type PanelImperativeHandle,
} from '@/primitives'
import { OnboardingRitual } from '@/features/onboarding/OnboardingRitual'
import { SessionOrbs } from '@/features/agent/SessionOrbs'
import { TurnReview } from '@/features/agent/TurnReview'
import { AppsMenu } from '@/features/apps/AppsMenu'
import { HistoryPanel } from '@/features/history/HistoryPanel'
import { BoardView } from '@/features/tasks/BoardView'
import { AgendaView } from '@/features/google/AgendaView'
import { MailView } from '@/features/google/MailView'
import { DialogHost } from './DialogHost'
import { FrontmatterFieldsHost } from '@/composites/FrontmatterFieldsHost'
import { PaneView } from './PaneView'
import { DrawerShell, EditorPane } from '@/composites'
import { FilePlaceholder } from '@/features/files/FilePlaceholder'
import { AppFrame } from '@/features/apps/AppFrame'
import { AppsSection } from '@/features/apps/AppsSection'
import { FileTree } from '@/features/explorer/FileTree'
import { ImageViewer } from '@/features/files/ImageViewer'
import { VaultPicker } from '@/features/vault/VaultPicker'
import { syncLabel } from '../lib/sync-label'
import { trpc } from '../lib/trpc'
import { sweepDailyAtom } from '../state/daily'
import { openLandingAtom } from '../state/landing'
import {
  activeTab,
  dropZones,
  focusPane,
  isSoloNote,
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
  pinTab,
  workspaceAtom,
  type Tab,
} from '../state/panes'
import { historyOpenAtom, historyTargetPathAtom } from '../state/history'
import { useGoogleAccount } from '../state/google'
import { openTaskCountAtom, tickNowAtom } from '../state/tasks'
import type { PaneDropZone } from '@/lib/tab-drop'
import type { ConflictResolvers } from '@/lib/editor-reload'
import { ConflictBanner } from '@/composites/ConflictBanner'
import { SessionsSection } from '@/features/agent/SessionsSection'
import { VaultSwitchConfirm } from '@/features/agent/VaultSwitchConfirm'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { runCommandAtom, useCommandHotkeys } from '../state/commands'
import { recentOfTab, touchRecentAtom } from '../state/recents'
import {
  closePaneWithExitAtom,
  closeTabWithExitAtom,
  leavingPaneAtom,
} from '../state/pane-exit'
import { applyVaultSwitchAtom, leavingVaultAtom, switchVaultAtom } from '../state/vault-switch'
import {
  agentSessionsAtom,
  agentSessionsSectionOpenAtom,
  useAgentSessions,
  useSessionTabs,
} from '@/state/agent'
import { reconcileAtom } from '@/state/agent-send'
import { sessionsWorthAsking } from '@/lib/agent-notices'

/** One shared empty array, so a pane not being dragged over keeps the same
 *  `allowed` reference between renders. */
const NO_ZONES: PaneDropZone[] = []
import { navOpenAtom, usePanelLayout } from '../state/preferences'
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

/** The apps and sessions sections' header row, in px: what a panel collapses
 *  to, so the control that reopens it stays. Both share tree-row metrics. */
const SECTION_HEADER_HEIGHT = 22

// warn is a named amber utility: there is no warning token yet, and named
// palette utilities are gate-legal (only arbitrary colour literals are banned).
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
  const openVault = useSetAtom(openVaultAtom)
  const openLanding = useSetAtom(openLandingAtom)
  const sweepDaily = useSetAtom(sweepDailyAtom)
  const setHistoryOpen = useSetAtom(historyOpenAtom)
  const [navOpen, setNavOpen] = useAtom(navOpenAtom)
  const historyTarget = useAtomValue(historyTargetPathAtom)
  const openTaskCount = useAtomValue(openTaskCountAtom)
  // The one place that asks main whether Google is connected; settings shares
  // this atom.
  const { account: googleAccount } = useGoogleAccount()
  const reconcile = useSetAtom(reconcileAtom)
  const abandonReconcile = useSetAtom(abandonReconcileAtom)
  const [heldBack, setHeldBack] = useAtom(heldBackAtom)
  /** The pane playing its exit, if any; the timer is the atom's
   *  (`state/pane-exit.ts`), so every close path shares it. */
  const leavingPane = useAtomValue(leavingPaneAtom)
  const closePaneWithExit = useSetAtom(closePaneWithExitAtom)
  const closeTabWithExit = useSetAtom(closeTabWithExitAtom)
  const runCommand = useSetAtom(runCommandAtom)

  // The application menu runs commands by id through the same table. ⌘W is
  // its accelerator, which fires before the page sees the key (`main/menu.ts`),
  // so Close Tab arrives here rather than as a keydown.
  useEffect(() => window.holi.menu.onCommand((id) => void runCommand(id)), [runCommand])

  // For the vault-switch confirm and the sessions panel's default size.
  const agentSessions = useAtomValue(agentSessionsAtom)
  // The sidebar's own vertical split: the tree, then the apps and sessions
  // sections under it.
  const sidebarLayout = usePanelLayout(activeRemote, 'sidebar')
  const hasApps = useAtomValue(hasAppsAtom)
  const [appsOpen, setAppsOpen] = useAtom(appsSectionOpenAtom)
  const hasSessions = agentSessions.length > 0
  const [sessionsOpen, setSessionsOpen] = useAtom(agentSessionsSectionOpenAtom)
  /** Handles on the collapsible sections, so the persisted open flags drive
   *  collapse/expand rather than each panel owning a second copy. */
  const appsPanelRef = useRef<PanelImperativeHandle | null>(null)
  const sessionsPanelRef = useRef<PanelImperativeHandle | null>(null)

  // Drive the panels from their open flags, one frame late: until the group
  // registers the panel's constraints, `isCollapsed()` throws and takes the
  // Shell down.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const drive = (panel: PanelImperativeHandle | null, want: boolean) => {
        if (!panel) return
        if (want && panel.isCollapsed()) panel.expand()
        else if (!want && !panel.isCollapsed()) panel.collapse()
      }
      drive(appsPanelRef.current, appsOpen)
      drive(sessionsPanelRef.current, sessionsOpen)
    })
    return () => cancelAnimationFrame(id)
  }, [appsOpen, hasApps, sessionsOpen, hasSessions])
  // Paint the active vault's colour/chrome theme onto the document root.
  useVaultTheme()
  // The session list and its whole-set effects. Mounted here because the shell
  // outlives every tab (D101).
  useAgentSessions()
  useSessionTabs(activeRemote)

  // Keep `nowAtom` on the current minute so `overdue` turns over on the clock.
  // Every 30s: the atom only changes when the minute string does, so the extra
  // tick is free. Not at module scope, where an interval would survive HMR.
  const tickNow = useSetAtom(tickNowAtom)
  useEffect(() => {
    const id = setInterval(() => tickNow(), 30_000)
    return () => clearInterval(id)
  }, [tickNow])
  /** The tab being dragged. Workspace state because which drops are possible
   *  spans panes: a shared edge is one gap (`dropZones`). */
  const [dragTab, setDragTab] = useState<Tab | null>(null)
  /**
   * Whether the drag is over a tab strip; the landing strips hide meanwhile.
   * Most drags are reorders that never leave the strip, so bands under every
   * nudge are noise. They still appear before the pointer aims at one, as soon
   * as it leaves the strip (D78).
   */
  const [overStrip, setOverStrip] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  /** Leaving this vault (switching, or adding one, which opens it) waits on an
   *  answer because sessions are running in it (D100). */
  const [leaving, setLeaving] = useAtom(leavingVaultAtom)
  /** An unmergeable external write, with the two ways out the editor handed up.
   *  Held as one object so the message can never outlive its resolvers. */
  const [banner, setBanner] = useState<{
    path: string
    resolve: ConflictResolvers
  } | null>(null)
  /** The vault already opened in main, so a re-render, or `openVault`
   *  re-setting `activeRemoteAtom` to the same value, does not re-open it. */
  const openedRemote = useRef<string | null>(null)

  // Open the active vault in main, land, then sweep prior days: once per
  // remote, deliberately sequential. The ONLY caller of `vaults.open`, so cold
  // start and a switch both open here.
  //
  // Landing needs the vault scanned, to tell a live target from a rotted one.
  // The sweep reuses the settings landing just cached: one file read.
  useEffect(() => {
    if (!activeRemote || openedRemote.current === activeRemote) return
    openedRemote.current = activeRemote
    void (async () => {
      await openVault(activeRemote)
      await openLanding()
      await sweepDaily()
    })()
  }, [activeRemote, openVault, openLanding, sweepDaily])

  // Every app-level key, from the one table (`state/commands.ts`, D102).
  useCommandHotkeys()

  const tab = activeTab(workspace)
  // The one place tab recents are recorded: whatever opened it, active is
  // what "recently opened" means.
  const touchRecent = useSetAtom(touchRecentAtom)
  useEffect(() => {
    if (tab === null) return
    const entry = recentOfTab(tab)
    if (entry !== null) touchRecent(entry)
  }, [tab, touchRecent])
  // Every way a drag can end, including escape and a drop with no handler, so
  // the landing strips never outlive it.
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

  // Feed the agent's per-turn hook the focused note, the one thing it cannot
  // discover itself. Main writes `.holi/state/context.local.json`.
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

  /** Both live in `state/vault-switch.ts` (D102): a switch is a command, and
   *  the confirm it may need is asked there, before the remote moves. */
  const applySwitch = useSetAtom(applyVaultSwitchAtom)
  const switchVault = useSetAtom(switchVaultAtom)
  // The conflict banner is about a file in the vault that just closed.
  useEffect(() => setBanner(null), [activeRemote])

  /**
   * Adding a vault activates it, ending sessions as a switch does. Asked at the
   * trigger, before someone names a repo and waits for a clone.
   */
  const addVault = () => {
    if (sessionsWorthAsking(agentSessions).length > 0) {
      setLeaving({ kind: 'add' })
      return
    }
    setShowAdd(true)
  }

  // A config-file conflict can leave the vault misconfigured, so it gets a loud
  // banner; content conflicts keep the quiet footer button
  // (docs/features/vaults-sync.md).
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
        {/* The nav is a DrawerShell; its content stays mounted while hidden, so
            the tree's expansion survives. */}
        <DrawerShell
          id="nav"
          side="left"
          open={navOpen}
          label="Sidebar"
          // Hidden, the nav closes to a rail: session orbs and the apps, which
          // are otherwise only clickable in the nav. The toggle rides the
          // drawer's moving edge and lands in the rail's top slot.
          edgeControl={
            <Tooltip
              content={
                <span className="inline-flex items-center gap-1.5">
                  {navOpen ? 'Hide sidebar' : 'Show sidebar'}
                  <Kbd>⌥⌘S</Kbd>
                </span>
              }
            >
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={navOpen ? 'Hide sidebar' : 'Show sidebar'}
                onClick={() => setNavOpen((open) => !open)}
              >
                {navOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
              </Button>
            </Tooltip>
          }
          rail={
            <>
              <SessionOrbs />
              <AppsMenu />
            </>
          }
          header={
            <VaultPicker
              vaults={vaults}
              activeRemote={activeRemote}
              onSelect={switchVault}
              onAddVault={addVault}
            />
          }
        >
          <div className="relative flex min-h-0 flex-1 flex-col">
              {showAdd && <OnboardingRitual mode="add-vault" onDismiss={() => setShowAdd(false)} />}
              {leaving !== null && (
                <VaultSwitchConfirm
                  intent={leaving.kind}
                  onConfirm={() => {
                    if (leaving.kind === 'switch') applySwitch(leaving.remote)
                    else {
                      setLeaving(null)
                      setShowAdd(true)
                    }
                  }}
                  onCancel={() => setLeaving(null)}
                />
              )}

              {/* The sidebar's own vertical group. The apps panel is absent
              rather than empty without apps: an empty panel still claims a
              slice and draws a handle. */}
              <ResizablePanelGroup
                orientation="vertical"
                className="min-h-0 flex-1"
                defaultLayout={sidebarLayout.defaultLayout}
                onLayoutChanged={(layout, meta) => {
                  sidebarLayout.onLayoutChanged(layout, meta)
                  // Reconcile a real drag back into the open flags. Only
                  // `isUserInteraction`: mount and reflow report sizes too, and
                  // would collapse sections behind the user's back.
                  //
                  // Ask the panel, not `layout`: a layout value is a flexGrow
                  // weight, not a pixel height.
                  if (!meta.isUserInteraction) return
                  setAppsOpen(appsPanelRef.current?.isCollapsed() === false)
                  setSessionsOpen(sessionsPanelRef.current?.isCollapsed() === false)
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
                      // Collapsed leaves the header row, which re-expands it.
                      collapsedSize={SECTION_HEADER_HEIGHT}
                      defaultSize={160}
                      minSize={66}
                      maxSize="60"
                      panelRef={appsPanelRef}
                    >
                      <AppsSection />
                    </ResizablePanel>
                  </>
                )}
                {/* Present even with no sessions: its `+` is the only mouse
                    path to a first one (D101). */}
                <ResizableHandle />
                <ResizablePanel
                  id="sessions"
                  collapsible
                  collapsedSize={SECTION_HEADER_HEIGHT}
                  defaultSize={hasSessions ? 140 : SECTION_HEADER_HEIGHT}
                  minSize={SECTION_HEADER_HEIGHT}
                  maxSize="60"
                  panelRef={sessionsPanelRef}
                >
                  <SessionsSection />
                </ResizablePanel>
              </ResizablePanelGroup>

              {/* Two rows, and `min-w-0` on each chip: a flex item's
              `min-width: auto` would otherwise scroll the narrow sidebar
              sideways. */}
              {/* `mt-auto` keeps the chips on the sidebar's floor. */}
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
                  {/* The gear opens the settings tab. */}
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

                {/* Agenda and mail are account-wide (D67) and appear only once
                Google is connected. `undefined` (not asked yet) hides them
                too, so they never flash. */}
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
            </div>
          </DrawerShell>


          <div className="flex min-w-60 flex-1 flex-col">
            {/* The panes. Layout deliberately not persisted: a stored layout
                is weights keyed to a panel count, and panes come and go. */}
            <ResizablePanelGroup orientation="horizontal" className="min-h-0">
              {workspace.panes.map((p, i) => (
                <Fragment key={i}>
                  {i > 0 && <ResizableHandle />}
                  <ResizablePanel id={`pane-${i}`} minSize={240}>
                    <PaneView
                      pane={p}
                      focused={i === workspace.active}
                      leaving={leavingPane === i}
                      solo={isSoloNote(workspace)}
                      onFocus={() => setWorkspace((w) => focusPane(w, i))}
                      // Every action focuses this pane first, then acts on the
                      // active pane.
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
                      // Answered workspace-wide: pane 1's left edge and pane
                      // 0's right edge are one gap.
                      allowed={
                        dragTab === null || overStrip ? NO_ZONES : dropZones(workspace, dragTab, i)
                      }
                      // Over the strip from the start, or the bands flash for
                      // a frame before the first `dragover`.
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
                          {/* Version history for the focused note. Only on the
                              active pane: `historyTargetPathAtom` reads its tab,
                              the drawer's own predicate. */}
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
                          {/* Closing a pane's last tab unsplits; this does it in
                              one gesture. */}
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
          </div>

          {/* The right-hand drawers; each decides whether it is open. The last
              turn (D88) is a diff over a commit range. */}
          <HistoryPanel />
          <TurnReview />

        <DialogHost />
        <CommandPalette />

        {/* Every frontmatter block's controls, portalled into their CodeMirror
            widgets. Here, not in EditorPane: a widget does not know its pane,
            and one host is one subscription. */}
        <FrontmatterFieldsHost />
      </div>

      {/* A config conflict outranks the quiet footer button, so a
          misconfigured vault cannot hide (docs/features/vaults-sync.md). */}
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

      {/* The large-file gate (docs/features/vaults-sync.md): files over the
          size cap are held out of git. Amber, not destructive: nothing is
          wrong, there is a decision to make. */}
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

      {/* Raised by an unmergeable external write to an open note
          (EditorPane's onConflict). */}
      {banner !== null && (
        <ConflictBanner
          path={banner.path}
          resolve={banner.resolve}
          onDismiss={() => setBanner(null)}
        />
      )}

      {/* The footer only reports: push is automatic (D61). */}
      <footer className="flex items-center justify-between gap-3 border-t border-divider px-3 py-1 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          {/* The sync state doubles as the entry to the vault's history. */}
          <Tooltip content="version history">
            <Button
              variant="link"
              // Override Button's `text-sm font-medium` to match the footer.
              className={`h-auto p-0 text-xs font-normal truncate ${TONE[label.tone]}`}
              onClick={() => setWorkspace(openHistory)}
            >
              {label.text}
            </Button>
          </Tooltip>
          {/* The conflict button below is for content conflicts only: a
              config conflict's banner owns the action. */}
          {/* While a reconcile runs its files are read-only, so offer the way
              out; otherwise the only escape is a terminal. */}
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
        {/* No agent control here: the sidebar lists sessions (D101). */}
      </footer>
    </div>
  )
}
