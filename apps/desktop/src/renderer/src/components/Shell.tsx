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
import { History, Settings, SquareKanban } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { fileKind, isTaskFilePath } from '@holi/shared'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/primitives'
import { OnboardingRitual } from './OnboardingRitual'
import { AgentPanel } from '@/features/agent/AgentPanel'
import { HistoryPanel } from '@/features/history/HistoryPanel'
import { BoardView } from '@/features/tasks/BoardView'
import { DialogHost } from './DialogHost'
import { EditorPane } from './EditorPane'
import { TaskFileEditor } from '@/features/tasks/TaskFileEditor'
import { FilePlaceholder } from './FilePlaceholder'
import { FileTree } from './FileTree'
import { fileIconFor } from './tree/file-icons'
import { ImageViewer } from './ImageViewer'
import { VaultPicker } from './VaultPicker'
import { VaultSettings } from '@/features/vault/VaultSettings'
import { syncLabel } from '../lib/sync-label'
import { trpc } from '../lib/trpc'
import { openTodaysDailyAtom, sweepDailyAtom } from '../state/daily'
import {
  activeTab,
  closeTab,
  openBoard,
  openPinned,
  openPreview,
  pinActive,
  pinTab,
  workspaceAtom,
} from '../state/panes'
import { sessionAtom } from '../state/session'
import { agentPanelOpenAtom } from '../state/agent'
import { historyOpenAtom, historyTargetPathAtom, vaultLogOpenAtom } from '../state/history'
import { VaultHistory } from '@/features/history/VaultHistory'
import { openTaskCountAtom } from '../state/tasks'
import { openDialogAtom } from '../state/dialogs'
import { usePanelLayout } from '../state/preferences'
import { activeRemoteAtom, openVaultAtom, reconcileAtom, syncStateAtom, vaultsAtom } from '../state/vaults'

const TONE = { quiet: 'text-neutral-500', busy: 'text-sky-400', warn: 'text-amber-400' } as const

export function Shell() {
  const session = useAtomValue(sessionAtom)
  const vaults = useAtomValue(vaultsAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const syncState = useAtomValue(syncStateAtom)
  const [workspace, setWorkspace] = useAtom(workspaceAtom)
  const setActiveRemote = useSetAtom(activeRemoteAtom)
  const openVault = useSetAtom(openVaultAtom)
  const openDaily = useSetAtom(openTodaysDailyAtom)
  const sweepDaily = useSetAtom(sweepDailyAtom)
  const setAgentOpen = useSetAtom(agentPanelOpenAtom)
  const setHistoryOpen = useSetAtom(historyOpenAtom)
  const historyOpen = useAtomValue(historyOpenAtom)
  const historyTarget = useAtomValue(historyTargetPathAtom)
  const [vaultLogOpen, setVaultLogOpen] = useAtom(vaultLogOpenAtom)
  const openDialog = useSetAtom(openDialogAtom)
  const openTaskCount = useAtomValue(openTaskCountAtom)
  const reconcile = useSetAtom(reconcileAtom)
  const shellLayout = usePanelLayout(activeRemote, 'shell')
  const [showSettings, setShowSettings] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  /** The vault already opened in main, so a re-render — or `openVault` itself
   *  re-setting `activeRemoteAtom` to the same value — does not re-open it. */
  const openedRemote = useRef<string | null>(null)

  // Open the active vault in main, then land on today's daily and sweep prior
  // days (FR-4/FR-5). One effect, once per remote, deliberately sequential.
  //
  // This is the ONLY caller of `vaults.open`, so cold start (the vault
  // `loadVaults` selects) and an explicit switch both open through here. The bug
  // this fixes: nothing opened the boot vault, so main's watcher never started
  // and the tree stayed empty until you manually switched. Daily runs *after*
  // open so it wins the race for the active doc; both no-op on shared vaults.
  useEffect(() => {
    if (!activeRemote || openedRemote.current === activeRemote) return
    openedRemote.current = activeRemote
    void (async () => {
      await openVault(activeRemote)
      await openDaily()
      await sweepDaily()
    })()
  }, [activeRemote, openVault, openDaily, sweepDaily])

  // FR-6: ⌘⇧D jumps to today's daily (creating it if needed).
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

  // ⌘J toggles the agent drawer (prd/agent.md §Runtime).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setAgentOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setAgentOpen])

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
  const pane = workspace.panes[workspace.active]!

  // Feed the agent's per-turn hook the focused note — the one piece of state it
  // cannot discover itself (editor-UI focus). Main writes it to
  // `.holi/context.local.json`; a no-op when no session is running.
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
  const switchVault = (remote: string) => {
    if (remote === activeRemote) return
    setWorkspace(() => ({ panes: [{ tabs: [], active: -1 }], active: 0 }))
    setBanner(null)
    setActiveRemote(remote)
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="flex min-h-0 flex-1">
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-w-0 flex-1"
          defaultLayout={shellLayout.defaultLayout}
          onLayoutChanged={shellLayout.onLayoutChanged}
        >
          <ResizablePanel id="nav" defaultSize={256} minSize={180} maxSize={440}>
            <aside className="relative flex h-full flex-col border-r border-neutral-900">
          <div className="flex h-11 items-center px-2">
            <VaultPicker
              vaults={vaults}
              activeRemote={activeRemote}
              onSelect={switchVault}
              onAddVault={() => setShowAdd(true)}
            />
          </div>
          {showAdd && (
            <OnboardingRitual mode="add-vault" onDismiss={() => setShowAdd(false)} />
          )}

          <FileTree
            activePath={tab?.kind === 'note' ? tab.path : null}
            onOpenPreview={open}
            onOpenPinned={openPin}
          />

          <div className="flex items-center gap-2 p-2">
            <button
              className="flex-1 rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
              // FR-6: opens today's daily (personal vaults only; the atom no-ops
              // otherwise). Also the empty-state recovery path — always here.
              title="today's daily note (⌘⇧D)"
              onClick={() => void openDaily()}
            >
              today
            </button>
            <button
              className="flex flex-1 items-center justify-center gap-1.5 rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
              title={`task board — ${openTaskCount} open`}
              onClick={() => setWorkspace((w) => openBoard(w))}
            >
              board
              {openTaskCount > 0 && (
                <span className="rounded-full bg-neutral-700 px-1.5 text-[10px] leading-4 text-neutral-200">
                  {openTaskCount}
                </span>
              )}
            </button>
            <button
              className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              title="vault settings"
              aria-label="vault settings"
              onClick={() => setShowSettings((v) => !v)}
            >
              <Settings size={16} />
            </button>
          </div>
            </aside>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel id="editor" minSize={360}>
            <main className="flex h-full min-w-0 flex-col">
          {/* One pane, one strip. The state is panes[] → tabs[] so a split is a
              second pane later rather than a rewrite. */}
          <div className="flex h-11 items-center gap-1 px-2">
            {pane.tabs.map((t, i) => (
              <span
                key={t.kind === 'note' ? t.path : 'board'}
                className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs ${
                  i === pane.active
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                <button
                  // A preview tab reads italic (VS Code); double-clicking it
                  // pins it, the same promotion editing performs.
                  className={`flex items-center gap-1.5 ${
                    t.kind === 'note' && t.preview ? 'italic' : ''
                  }`}
                  title={t.kind === 'board' ? 'task board' : t.path}
                  onClick={() =>
                    setWorkspace((w) => ({
                      ...w,
                      panes: w.panes.map((p, pi) => (pi === w.active ? { ...p, active: i } : p)),
                    }))
                  }
                  onDoubleClick={() => setWorkspace((w) => pinTab(w, i))}
                >
                  {t.kind === 'board' ? <SquareKanban size={14} /> : fileIconFor(t.path)}
                  <span>{t.kind === 'board' ? 'board' : t.path.split('/').at(-1)}</span>
                </button>
                <button
                  className="text-neutral-600 hover:text-neutral-300"
                  title="close tab"
                  onClick={() => setWorkspace((w) => closeTab(w, i))}
                >
                  ✕
                </button>
              </span>
            ))}
            {/* Version history for the focused note — a header button toggling the
                right-hand drawer. `historyTargetPathAtom` is the one predicate the
                drawer also uses (a markdown note, not a task/image/pdf), so button
                and drawer never disagree. Mirrors how the agent panel opens. */}
            {historyTarget !== null && (
              <button
                className="ml-auto rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                title="version history"
                onClick={() => setHistoryOpen((v) => !v)}
              >
                <History size={16} />
              </button>
            )}
          </div>

          {tab?.kind === 'board' ? (
            <BoardView />
          ) : tab?.kind === 'note' && fileKind(tab.path) === 'image' ? (
            <ImageViewer path={tab.path} />
          ) : tab?.kind === 'note' && fileKind(tab.path) !== 'markdown' ? (
            // Non-image, non-markdown files open a typed placeholder for now — a
            // real per-type viewer replaces it later (spec §Arbitrary files).
            <FilePlaceholder path={tab.path} kind={fileKind(tab.path) as 'text' | 'pdf' | 'doc'} />
          ) : tab?.kind === 'note' && isTaskFilePath(tab.path) ? (
            // A task file renders as a task — a structured header over the body —
            // instead of raw frontmatter (prd/tasks.md; the file is still the truth).
            <TaskFileEditor
              path={tab.path}
              onOpenNote={open}
              onEdit={() => setWorkspace((w) => pinActive(w))}
              onConflict={(path) =>
                setBanner(`${path} changed underneath your edit and could not be merged`)
              }
            />
          ) : (
            <EditorPane
              path={tab?.kind === 'note' ? tab.path : null}
              onOpenNote={open}
              onEdit={() => setWorkspace((w) => pinActive(w))}
              onConflict={(path) =>
                // The ordinary reconcile affordance is the agent drawer
                // (FR-18), which is plan 6. Until it exists, say so plainly
                // rather than silently holding a buffer that cannot be merged.
                setBanner(`${path} changed underneath your edit and could not be merged`)
              }
            />
          )}
            </main>
          </ResizablePanel>

          {historyOpen && historyTarget !== null && (
            <>
              <ResizableHandle />
              <ResizablePanel id="history" defaultSize={384} minSize={220}>
                <HistoryPanel />
              </ResizablePanel>
            </>
          )}

          {showSettings && (
            <>
              <ResizableHandle />
              <ResizablePanel id="settings" defaultSize={320} minSize={240}>
                <VaultSettings onClose={() => setShowSettings(false)} />
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

        {vaultLogOpen && <VaultHistory onClose={() => setVaultLogOpen(false)} />}
        <DialogHost />
      </div>

      {/* The reconcile banner sits above the footer, beside the sync state it
          qualifies — an unmergeable external write to the open note raises it
          (EditorPane's onConflict), the one thing left that a user must answer. */}
      {banner !== null && (
        <p className="border-t border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-[11px] text-amber-100">
          {banner}
        </p>
      )}

      {/* Sync state lives bottom-left: "where am I and is it saved elsewhere" is
          one glance. There is no Push button — push is automatic (D61) — so the
          footer only reports; sign out lives in settings. */}
      <footer className="flex items-center justify-between gap-3 border-t border-neutral-900 px-3 py-1 text-xs text-neutral-500">
        <div className="flex min-w-0 items-center gap-2">
          {/* The sync state doubles as the entry to the whole-vault commit history
              (comment: "clickable — up to date opens version control"). */}
          <button
            className={`truncate hover:underline ${TONE[label.tone]}`}
            title="version history"
            onClick={() => setVaultLogOpen(true)}
          >
            {label.text}
          </button>
          {syncState.kind === 'conflict' && (
            <button
              className="shrink-0 rounded border border-amber-700/60 px-1.5 py-0.5 text-[11px] text-amber-300 hover:bg-amber-950/40"
              title="Re-run the merge and hand the conflict to the vault assistant to resolve"
              onClick={() => void reconcile()}
            >
              Ask Claude to reconcile
            </button>
          )}
        </div>
        <span className="shrink-0 truncate">
          {(activeRemote ?? 'no vault') + (session?.login ? ` · ${session.login}` : '')}
        </span>
      </footer>
    </div>
  )
}
