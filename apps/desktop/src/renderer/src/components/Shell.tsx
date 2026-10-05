/**
 * The app, once someone is signed in: a vault, its tree, and whatever tabs are
 * open over it. The snapshot push is subscribed once at the root, so this reads
 * atoms. An agent session is an ordinary tab. What plugins add to the frame
 * (rail and sidebar sections, drawers) comes from the running plugins.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { History, PanelLeftClose, PanelLeftOpen, PanelRight } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { isVaultConfigPath } from '@holi/shared'
import {
  Button,
  IconButton,
  Kbd,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Tooltip,
} from '@/primitives'
import { OnboardingRitual } from '@/features/onboarding/OnboardingRitual'
import { HistoryPanel } from '@/features/history/HistoryPanel'
import { DialogHost } from './DialogHost'
import { FrontmatterFieldsHost } from '@/features/frontmatter/FrontmatterFieldsHost'
import { PaneView } from './PaneView'
import { DrawerShell } from '@/composites'
import { FileTree } from '@/features/explorer/FileTree'
import { NavMenu } from '@/features/nav/NavMenu'
import { VaultPicker } from '@/features/vault/VaultPicker'
import { trpc } from '../lib/trpc'
import { sweepDailyAtom } from '../state/daily'
import { openLandingAtom } from '../state/home'
import { useSettingsFollowDisk } from '../state/settings'
import {
  activeTab,
  dropZones,
  focusPane,
  moveTab,
  moveTabToNewPane,
  pinActive,
  pinTab,
  workspaceAtom,
  type Tab,
} from '../state/panes'
import { pathOfTab } from '@/lib/folder-documents'
import { historyOpenAtom, historyTargetPathAtom } from '../state/history'
import { tickNowAtom } from '../state/clock'
import type { PaneDropZone } from '@/lib/tab-drop'
import type { Surface } from '@/plugin-api/types'
import type { ConflictResolvers } from '@/lib/editor-reload'
import { ConflictBanner } from '@/composites/ConflictBanner'
import { LeaveConfirm } from './LeaveConfirm'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { QuickAddHost } from '@/features/tasks/QuickAddHost'
import { runCommandAtom, useCommandHotkeys } from '../state/commands'
import { recentOfTab, touchRecentAtom } from '../state/recents'
import { closePaneWithExitAtom, closeTabWithExitAtom, leavingPaneAtom } from '../state/pane-exit'
import { applyVaultSwitchAtom, leavingVaultAtom, switchVaultAtom } from '../state/vault-switch'
import { pendingVaultPromptAtom, startPendingVaultPromptAtom } from '../state/vault-removal'
import { openPathAtom, useSurfaceTabs } from '@/state/surfaces'
import {
  folderClaimsAtom,
  leaveReasonsAtom,
  runningPluginsAtom,
  surfacesAtom,
} from '@/state/plugins'
import { useAgentService } from '@/state/agent-service'
import { reconcileAtom } from '@/state/reconcile'

/** One shared empty array, so a pane not being dragged over keeps the same
 *  `allowed` reference between renders. */
const NO_ZONES: PaneDropZone[] = []
import { navOpenAtom } from '../state/preferences'
import { useVaultTheme } from '../state/theme'
import {
  activeRemoteAtom,
  heldBackAtom,
  openVaultAtom,
  retrySyncAtom,
  syncStateAtom,
  vaultsAtom,
} from '../state/vaults'

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
  const startPendingPrompt = useSetAtom(startPendingVaultPromptAtom)
  const setPendingPrompt = useSetAtom(pendingVaultPromptAtom)
  const setHistoryOpen = useSetAtom(historyOpenAtom)
  const openPath = useSetAtom(openPathAtom)
  const folderClaims = useAtomValue(folderClaimsAtom)
  const surfaces = useAtomValue(surfacesAtom)
  const running = useAtomValue(runningPluginsAtom)
  const [navOpen, setNavOpen] = useAtom(navOpenAtom)
  const historyTarget = useAtomValue(historyTargetPathAtom)
  const reconcile = useSetAtom(reconcileAtom)
  const agent = useAgentService()
  const retrySync = useSetAtom(retrySyncAtom)
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

  // For the add-vault confirm.
  const leaveReasons = useAtomValue(leaveReasonsAtom)
  // Paint the active vault's colour/chrome theme onto the document root.
  useVaultTheme()
  // Settings edited on disk (the agent's `home:`, a pull) reach the app.
  useSettingsFollowDisk()
  useSurfaceTabs()

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
   * as it leaves the strip.
   */
  const [overStrip, setOverStrip] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  /** Leaving this vault (switching, or adding one, which opens it) waits on an
   *  answer because something running in it would be lost. */
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
  // Opening on Home needs the vault scanned, to tell a live target from a
  // missing one. The sweep reuses the settings it just cached: one file read.
  useEffect(() => {
    if (!activeRemote || openedRemote.current === activeRemote) return
    openedRemote.current = activeRemote
    void (async () => {
      await openVault(activeRemote)
      await openLanding()
      // A session asked for before this vault was open: the stuck push a
      // leave or delete was blocked on.
      await startPendingPrompt(activeRemote)
      await sweepDaily()
    })()
  }, [activeRemote, openVault, openLanding, startPendingPrompt, sweepDaily])

  // Every app-level key, from the one table (`state/commands.ts`).
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

  // Single-click / link-nav opens a preview tab (browsing costs one tab);
  // double-click pins. Editing a preview promotes it (see EditorPane onEdit).
  // A folder document (an app) opens with a note's gestures as its surface's
  // tab, which has no preview state.
  const open = (path: string) => openPath(path, 'preview')
  const openPin = (path: string) => openPath(path, 'pinned')

  /** Both live in `state/vault-switch.ts`: a switch is a command, and
   *  the confirm it may need is asked there, before the remote moves. */
  const applySwitch = useSetAtom(applyVaultSwitchAtom)
  const switchVault = useSetAtom(switchVaultAtom)
  // The conflict banner is about a file in the vault that just closed.
  useEffect(() => setBanner(null), [activeRemote])

  /**
   * Adding a vault activates it, leaving this one as a switch does. Asked at
   * the trigger, before someone names a repo and waits for a clone.
   */
  const addVault = () => {
    if (leaveReasons.length > 0) {
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
          // Hidden, the nav closes to a rail: the plugins' rail sections (the
          // session orbs), then the nav menu on its side at the foot. The toggle rides the drawer's moving edge
          // and lands in the rail's top slot.
          edgeControl={
            <IconButton
              icon={navOpen ? PanelLeftClose : PanelLeftOpen}
              label={navOpen ? 'Hide sidebar' : 'Show sidebar'}
              tooltip={
                <span className="inline-flex items-center gap-1.5">
                  {navOpen ? 'Hide sidebar' : 'Show sidebar'}
                  <Kbd>⌘B</Kbd>
                </span>
              }
              onClick={() => setNavOpen((open) => !open)}
            />
          }
          rail={
            <>
              {running.map(({ info, railSection: Section }) =>
                Section === undefined ? null : <Section key={info.id} />,
              )}
              <NavMenu orientation="vertical" />
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
              <LeaveConfirm
                intent={leaving.kind}
                onConfirm={() => {
                  if (leaving.kind === 'switch') applySwitch(leaving.remote)
                  else {
                    setLeaving(null)
                    setShowAdd(true)
                  }
                }}
                onCancel={() => {
                  setLeaving(null)
                  setPendingPrompt(null)
                }}
              />
            )}

            {/* The tree, then the plugins' sidebar sections (the vault's live
              sessions) directly above the nav menu: no header, nothing to
              resize. */}
            <div className="flex min-h-0 flex-1 flex-col">
              {/* A flex column, so the tree's own `flex-1` has a height to
                  fill and its list scrolls inside it rather than running on
                  under the sessions and the menu. The bottom margin keeps a
                  clear band between a scrolled tree and what sits below it. */}
              <div className="mb-3 flex min-h-0 flex-1 flex-col">
                <FileTree
                  activePath={pathOfTab(folderClaims, tab)}
                  onOpenPreview={open}
                  onOpenPinned={openPin}
                  onOpenInNewPane={(path) => openPath(path, 'pane')}
                />
              </div>
              {running.map(({ info, sidebarSection: Section }) =>
                Section === undefined ? null : <Section key={info.id} />,
              )}
            </div>

            {/* The nav menu on the sidebar's floor. It opens upward
              over the sessions and the tree. The left padding centres its
              first icons on the tree's chevrons: a root row's `pl-6` puts a
              14px chevron's centre at 31px, and 11px here plus the bar's 4px
              and a 32px button's 8px inset puts a 16px icon's centre there. */}
            <div className="flex shrink-0 py-2 pr-2 pl-2.75">
              <NavMenu />
            </div>
          </div>
        </DrawerShell>

        <div className="relative flex min-w-60 flex-1 flex-col">
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
                    onDropTab={(t, index) => setWorkspace((w) => moveTab(w, t, { pane: i, index }))}
                    onDropEdge={(t, side) =>
                      setWorkspace((w) => moveTabToNewPane(w, t, side === 'before' ? i : i + 1))
                    }
                    trailing={
                      <>
                        {/* The active surface's own controls (an app's reload
                            and log, an agent tab's new session). */}
                        <SurfaceActions tab={p.tabs[p.active]} surfaces={surfaces} />
                        {/* Version history for the focused note. Only on the
                              active pane: `historyTargetPathAtom` reads its tab,
                              the drawer's own predicate. */}
                        {i === workspace.active && historyTarget !== null && (
                          <IconButton
                            icon={History}
                            label="version history"
                            className="ml-1"
                            onClick={() => setHistoryOpen((v) => !v)}
                          />
                        )}
                        {/* Closing a pane's last tab unsplits; this does it in
                              one gesture. */}
                        {workspace.panes.length > 1 && (
                          <IconButton
                            icon={PanelRight}
                            label="close this pane"
                            className="ml-1"
                            onClick={() => closePaneWithExit(i)}
                          />
                        )}
                      </>
                    }
                  />
                </ResizablePanel>
              </Fragment>
            ))}
          </ResizablePanelGroup>
          {/* What plugins float over the panes: clear of a pane's own tab
              strip, and out of the way of everything but itself. */}
          <div className="pointer-events-none absolute inset-x-0 top-11 bottom-0 z-30">
            {running.map(({ info, overlay: Overlay }) =>
              Overlay === undefined ? null : <Overlay key={info.id} />,
            )}
          </div>
        </div>

        {/* The right-hand drawers; each decides whether it is open. */}
        <HistoryPanel />
        {running.flatMap(({ info, drawers = [] }) =>
          drawers.map((Drawer, i) => <Drawer key={`${info.id}:${i}`} />),
        )}

        <DialogHost />
        <CommandPalette />
        <QuickAddHost />

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
          <Button variant="ghost" size="xs" className="shrink-0" onClick={() => void retrySync()}>
            Try again
          </Button>
          {agent !== null && (
            <Tooltip content="Re-run the merge and hand the conflict to the vault assistant to resolve">
              <Button
                variant="destructive"
                size="xs"
                className="shrink-0"
                onClick={() => void reconcile()}
              >
                Ask {agent.name} to reconcile
              </Button>
            </Tooltip>
          )}
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
    </div>
  )
}

/** The pane-header actions of the surface its active tab is, if it has any. */
function SurfaceActions({
  tab,
  surfaces,
}: {
  tab: Tab | undefined
  surfaces: ReadonlyMap<string, Surface>
}): React.JSX.Element | null {
  const Actions = tab?.kind === 'surface' ? surfaces.get(tab.surface)?.headerActions : undefined
  if (tab?.kind !== 'surface' || Actions === undefined) return null
  return <Actions {...(tab.id === undefined ? {} : { id: tab.id })} />
}
