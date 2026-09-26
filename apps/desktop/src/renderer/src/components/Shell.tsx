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
 * The agent is not a panel here any more (D101): a session is an ordinary tab,
 * so ⌘J opens one rather than sliding a drawer out, and the sidebar's sessions
 * list is the rest of what the app says about them.
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
import { SessionsMenu } from '@/features/agent/SessionsMenu'
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

// quiet/busy map to semantic tokens; warn stays a named amber utility — there is
// no warning token yet, and named palette utilities are gate-legal (only arbitrary
// colour literals are banned).
/** The apps and sessions sections' header row, in px — what a panel collapses
 *  TO, so the control that reopens the section does not vanish along with it.
 *  One number: both sections are built to the same tree-row metrics, and two
 *  copies would be two things to keep equal. */
const SECTION_HEADER_HEIGHT = 22

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
  // Also the one place that asks main whether Google is connected at all — the
  // settings panel shares this atom rather than holding its own answer.
  const { account: googleAccount } = useGoogleAccount()
  const reconcile = useSetAtom(reconcileAtom)
  const abandonReconcile = useSetAtom(abandonReconcileAtom)
  const [heldBack, setHeldBack] = useAtom(heldBackAtom)
  /** The pane playing its exit, if any; the timer that drives it is the
   *  atom's (`state/pane-exit.ts`), so a key, the menu and the palette all
   *  close through the same one. */
  const leavingPane = useAtomValue(leavingPaneAtom)
  const closePaneWithExit = useSetAtom(closePaneWithExitAtom)
  const closeTabWithExit = useSetAtom(closeTabWithExitAtom)
  const runCommand = useSetAtom(runCommandAtom)

  // The application menu runs commands by id through the same table. ⌘W is
  // its accelerator, which fires before the page sees the key (`main/menu.ts`),
  // so Close Tab arrives here rather than as a keydown.
  useEffect(() => window.holi.menu.onCommand((id) => void runCommand(id)), [runCommand])

  // Only for the vault-switch confirm and the sessions panel's presence now that
  // the footer no longer reduces the set to a dot. What each session is doing is
  // the sidebar's to say, per card.
  const agentSessions = useAtomValue(agentSessionsAtom)
  // The sidebar's own vertical split: the tree, then the apps and sessions
  // sections under it.
  const sidebarLayout = usePanelLayout(activeRemote, 'sidebar')
  const hasApps = useAtomValue(hasAppsAtom)
  const [appsOpen, setAppsOpen] = useAtom(appsSectionOpenAtom)
  const hasSessions = agentSessions.length > 0
  const [sessionsOpen, setSessionsOpen] = useAtom(agentSessionsSectionOpenAtom)
  /** Imperative handles on the two collapsible sections, so the persisted open
   *  flags drive collapse/expand rather than each panel owning a second copy of
   *  that state. */
  const appsPanelRef = useRef<PanelImperativeHandle | null>(null)
  const sessionsPanelRef = useRef<PanelImperativeHandle | null>(null)

  // Drive the panels from their open flags, one frame late. The wait is not
  // politeness: the ref is attached before effects run, but the GROUP has not
  // registered the panel's constraints yet, and `isCollapsed()` throws `Panel
  // constraints not found` if you ask before it has — taking the whole Shell
  // down with it.
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
  // The session list, and the two things that are about the whole set: tabs for
  // sessions that have gone, and the turn review on a vault switch. Mounted here
  // because the shell is what outlives every tab (D101).
  useAgentSessions()
  useSessionTabs(activeRemote)

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
  /** Leaving this vault is waiting on an answer, because sessions are running in
   *  it (D100). Either picking another vault, or adding one — which opens it,
   *  and so ends them just the same. */
  const [leaving, setLeaving] = useAtom(leavingVaultAtom)
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

  // Every app-level key, from the one table (`state/commands.ts`, D102). What
  // each key does is written beside its row there, not here.
  useCommandHotkeys()

  const tab = activeTab(workspace)
  // The one place recents are recorded for tabs (`state/recents.ts`): whatever
  // opened this tab — the tree, the strip, a link, the palette — it is active
  // now, and that is what "recently opened" means.
  const touchRecent = useSetAtom(touchRecentAtom)
  useEffect(() => {
    if (tab === null) return
    const entry = recentOfTab(tab)
    if (entry !== null) touchRecent(entry)
  }, [tab, touchRecent])
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

  /** Both live in `state/vault-switch.ts` (D102): a switch is a command, and
   *  the confirm it may need is asked there, before the remote moves. */
  const applySwitch = useSetAtom(applyVaultSwitchAtom)
  const switchVault = useSetAtom(switchVaultAtom)
  // The conflict banner is about a file in the vault that just closed.
  useEffect(() => setBanner(null), [activeRemote])

  /**
   * …and adding one is the same departure, asked at the start.
   *
   * The ritual ends by activating the vault it just made, so it takes the
   * sessions with it exactly as the picker does. The moment to say so is before
   * someone has named a repo and waited for a clone, not after — which is also
   * why this guards the trigger rather than the ritual's last act.
   */
  const addVault = () => {
    if (sessionsWorthAsking(agentSessions).length > 0) {
      setLeaving({ kind: 'add' })
      return
    }
    setShowAdd(true)
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
        {/* The nav is a drawer like every other sidebar (DrawerShell): it slides
            in from the left and pushes the editor, hides with ⌥⌘S, and keeps its
            content mounted while hidden, so the tree's expansion survives. */}
        <DrawerShell
          id="nav"
          side="left"
          open={navOpen}
          keepMounted
          label="Sidebar"
          actions={[
            {
              icon: <PanelLeftClose />,
              label: 'Hide sidebar',
              hotkey: '⌥⌘S',
              boundByCommand: true,
              onSelect: () => setNavOpen(false),
            },
          ]}
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
                      // Collapsed leaves exactly the header row, which is the
                      // control that expands it again. Collapsing to 0 would take
                      // the section's own affordance away with it.
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
                {/* A third section of the same column, collapsible to its own
                    header like the apps list — but present whether or not the
                    vault has sessions, because since D101 removed the footer's
                    Claude control this is the only place a first one can be
                    started with the mouse — the `+` beside its heading. Its
                    resting height follows what it holds: room for a list when
                    there is one, the heading alone when there is not. */}
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
            </div>
          </DrawerShell>


          <div className="flex min-w-60 flex-1 flex-col">
            {/* The panes. One `ResizablePanelGroup` nested inside the editor
                slot, so the split resizes against itself and the sidebars and
                the history panel are untouched by it.

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
                      solo={isSoloNote(workspace)}
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
                      // With the nav hidden, the way back for the mouse sits where
                      // the nav's edge was: the start of the first pane's strip.
                      // Sessions and apps come with it, since the nav was the
                      // only place either could be clicked.
                      leading={
                        i === 0 &&
                        !navOpen && (
                          <>
                          <Tooltip
                            content={
                              <span className="inline-flex items-center gap-1.5">
                                Show sidebar
                                <Kbd>⌥⌘S</Kbd>
                              </span>
                            }
                          >
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="shrink-0 text-muted-foreground"
                              aria-label="Show sidebar"
                              onClick={() => setNavOpen(true)}
                            >
                              <PanelLeftOpen size={16} />
                            </Button>
                          </Tooltip>
                          <SessionsMenu />
                          <AppsMenu />
                          </>
                        )
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
          </div>

          {/* The right-hand drawers. Each decides for itself whether it is open,
              and slides in and out of this row (DrawerShell). History follows
              the focused note; the last turn (D88) is the same kind of reading,
              a diff over a commit range rather than over one commit. */}
          <HistoryPanel />
          <TurnReview />

        <DialogHost />
        <CommandPalette />

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
        {/* The footer's Claude control is gone (D101). It was one dot standing
            for every session, and it was worth a permanent corner while a
            session's state had nowhere else to live — the drawer hid them and
            the sidebar had no list. The sidebar lists them now, by name, with
            the same dot and the state in words beside it, so the footer's
            version was a second copy of a fuller answer three feet away. ⌘J
            still goes to the agent. */}
      </footer>
    </div>
  )
}
