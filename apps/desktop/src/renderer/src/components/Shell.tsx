/**
 * The app, once someone is signed in: a vault, its tree, and whatever tabs are
 * open over it. The snapshot push is subscribed once at the root, so this reads
 * atoms. An agent session is an ordinary tab.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { History, PanelLeftClose, PanelLeftOpen, PanelRight } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { fileKind, isAppBundlePath, isTaskFilePath, isVaultConfigPath } from '@holi/shared'
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
import { SessionOrbs } from '@/features/agent/SessionOrbs'
import { TurnReview } from '@/features/agent/TurnReview'
import { HistoryPanel } from '@/features/history/HistoryPanel'
import { BoardView } from '@/features/tasks/BoardView'
import { AgendaView } from '@/features/google/AgendaView'
import { MailView } from '@/features/google/MailView'
import { DialogHost } from './DialogHost'
import { FrontmatterFieldsHost } from '@/features/frontmatter/FrontmatterFieldsHost'
import { PaneView } from './PaneView'
import { DrawerShell } from '@/composites'
import { FilePlaceholder } from '@/features/files/FilePlaceholder'
import { AppFrame } from '@/features/apps/AppFrame'
import { FileTree } from '@/features/explorer/FileTree'
import { NavMenu } from '@/features/nav/NavMenu'
import { ImageViewer } from '@/features/files/ImageViewer'
import { VaultPicker } from '@/features/vault/VaultPicker'
import { trpc } from '../lib/trpc'
import { sweepDailyAtom } from '../state/daily'
import { openLandingAtom } from '../state/landing'
import {
  activeTab,
  dropZones,
  focusPane,
  moveTab,
  moveTabToNewPane,
  openApp,
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
import { tickNowAtom } from '../state/clock'
import type { PaneDropZone } from '@/lib/tab-drop'
import type { ConflictResolvers } from '@/lib/editor-reload'
import { ConflictBanner } from '@/composites/ConflictBanner'
import { SessionRows } from '@/features/agent/SessionRows'
import { SessionActions } from '@/features/agent/SessionActions'
import { VaultSwitchConfirm } from '@/features/agent/VaultSwitchConfirm'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { QuickAddHost } from '@/features/tasks/QuickAddHost'
import { runCommandAtom, useCommandHotkeys } from '../state/commands'
import { recentOfTab, touchRecentAtom } from '../state/recents'
import { closePaneWithExitAtom, closeTabWithExitAtom, leavingPaneAtom } from '../state/pane-exit'
import { applyVaultSwitchAtom, leavingVaultAtom, switchVaultAtom } from '../state/vault-switch'
import { pendingVaultPromptAtom, startPendingVaultPromptAtom } from '../state/vault-removal'
import { agentSessionsAtom, useAgentSessions, useAgentTabs } from '@/state/agent'
import { reconcileAtom } from '@/state/agent-send'
import { sessionsWorthAsking } from '@/lib/agent-notices'

/** One shared empty array, so a pane not being dragged over keeps the same
 *  `allowed` reference between renders. */
const NO_ZONES: PaneDropZone[] = []
import { navOpenAtom } from '../state/preferences'
import { useVaultTheme } from '../state/theme'
import {
  activeRemoteAtom,
  heldBackAtom,
  openVaultAtom,
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
  const [navOpen, setNavOpen] = useAtom(navOpenAtom)
  const historyTarget = useAtomValue(historyTargetPathAtom)
  // The one place that asks main whether Google is connected; settings and the
  // nav menu share this atom.
  useGoogleAccount()
  const reconcile = useSetAtom(reconcileAtom)
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

  // For the vault-switch confirm.
  const agentSessions = useAtomValue(agentSessionsAtom)
  // Paint the active vault's colour/chrome theme onto the document root.
  useVaultTheme()
  // The session and terminal lists and their whole-set effects. Mounted here
  // because the shell outlives every tab.
  useAgentSessions()
  useAgentTabs(activeRemote)

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
   *  answer because sessions are running in it. */
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

  const pane = workspace.panes[workspace.active]!

  // Feed the agent's per-turn hook the focused note, the one thing it cannot
  // discover itself. Main writes `.holi/state/context.local.json`.
  //
  // Typing to the agent focuses the agent's own tab, so that tab keeps the
  // note that was focused before it: otherwise every prompt typed in Holi
  // would report no note at all. Open notes are counted across every pane.
  const focusedNote = useRef<string | null>(null)
  useEffect(() => {
    const openPaths = workspace.panes.flatMap((p) =>
      p.tabs.flatMap((t) => (t.kind === 'note' ? [t.path] : [])),
    )
    if (tab?.kind === 'note') focusedNote.current = tab.path
    else if (tab?.kind !== 'agent') focusedNote.current = null
    if (focusedNote.current !== null && !openPaths.includes(focusedNote.current)) {
      focusedNote.current = null
    }
    window.holi.agent.setFocus({ focusedPath: focusedNote.current, openPaths })
  }, [tab, workspace.panes])
  // Single-click / link-nav opens a preview tab (browsing costs one tab);
  // double-click pins. Editing a preview promotes it (see EditorPane onEdit).
  // A bundle path is an app: the tree opens one with a note's gestures,
  // and it opens as an app tab, which has no preview state.
  const open = (path: string) =>
    setWorkspace((w) => (isAppBundlePath(path) ? openApp(w, path) : openPreview(w, path)))
  const openPin = (path: string) =>
    setWorkspace((w) => (isAppBundlePath(path) ? openApp(w, path) : openPinned(w, path)))

  /** Both live in `state/vault-switch.ts`: a switch is a command, and
   *  the confirm it may need is asked there, before the remote moves. */
  const applySwitch = useSetAtom(applyVaultSwitchAtom)
  const switchVault = useSetAtom(switchVaultAtom)
  // The conflict banner is about a file in the vault that just closed.
  useEffect(() => setBanner(null), [activeRemote])

  /**
   * Adding a vault activates it, stopping sessions as a switch does. Asked at the
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
          // Hidden, the nav closes to a rail: session orbs, then the nav menu
          // on its side at the foot. The toggle rides the drawer's moving edge
          // and lands in the rail's top slot.
          edgeControl={
            <IconButton
              icon={navOpen ? PanelLeftClose : PanelLeftOpen}
              label={navOpen ? 'Hide sidebar' : 'Show sidebar'}
              tooltip={
                <span className="inline-flex items-center gap-1.5">
                  {navOpen ? 'Hide sidebar' : 'Show sidebar'}
                  <Kbd>⌥⌘S</Kbd>
                </span>
              }
              onClick={() => setNavOpen((open) => !open)}
            />
          }
          rail={
            <>
              <SessionOrbs />
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
              <VaultSwitchConfirm
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

            {/* The tree, then the vault's live sessions on the row directly
              above the nav menu: no header, nothing to resize. */}
            <div className="flex min-h-0 flex-1 flex-col">
              {/* A flex column, so the tree's own `flex-1` has a height to
                  fill and its list scrolls inside it rather than running on
                  under the sessions and the menu. The bottom margin keeps a
                  clear band between a scrolled tree and what sits below it. */}
              <div className="mb-3 flex min-h-0 flex-1 flex-col">
                <FileTree
                  activePath={tab?.kind === 'note' || tab?.kind === 'app' ? tab.path : null}
                  onOpenPreview={open}
                  onOpenPinned={openPin}
                  onOpenInNewPane={(path) =>
                    setWorkspace((w) =>
                      openInNewPane(
                        w,
                        isAppBundlePath(path) ? { kind: 'app', path } : { kind: 'note', path },
                      ),
                    )
                  }
                />
              </div>
              {/* Many sessions scroll rather than squeeze the tree away. */}
              <div className="max-h-[40%] shrink-0 overflow-y-auto">
                <SessionRows />
              </div>
            </div>

            {/* The nav menu on the sidebar's floor. It opens upward
              over the sessions and the tree. */}
            <div className="flex shrink-0 p-2">
              <NavMenu />
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
                        {/* An assistant tab's actions (`SessionActions`). */}
                        {p.tabs[p.active]?.kind === 'agent' && <SessionActions />}
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
        </div>

        {/* The right-hand drawers; each decides whether it is open. The last
              turn is a diff over a commit range. */}
        <HistoryPanel />
        <TurnReview />

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
    </div>
  )
}
