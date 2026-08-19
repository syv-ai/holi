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
import { CalendarDays, History, LayoutGrid, Mail, Settings, SquareKanban } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { fileKind, isTaskFilePath, isVaultConfigPath } from '@holi/shared'
import { Button, ResizableHandle, ResizablePanel, ResizablePanelGroup, Tooltip } from '@/primitives'
import { OnboardingRitual } from '@/features/onboarding/OnboardingRitual'
import { AgentPanel } from '@/features/agent/AgentPanel'
import { HistoryPanel } from '@/features/history/HistoryPanel'
import { BoardView } from '@/features/tasks/BoardView'
import { AgendaView } from '@/features/google/AgendaView'
import { MailView } from '@/features/google/MailView'
import { GoogleConnection } from '@/features/google/GoogleConnection'
import { DialogHost } from './DialogHost'
import { EditorPane } from '@/composites'
import { TaskFileEditor } from '@/features/tasks/TaskFileEditor'
import { FilePlaceholder } from '@/features/files/FilePlaceholder'
import { AppFrame } from '@/features/apps/AppFrame'
import { AppsSection } from '@/features/apps/AppsSection'
import { FileTree } from '@/features/explorer/FileTree'
import { fileIconFor } from '@/features/explorer/file-icons'
import { ImageViewer } from '@/features/files/ImageViewer'
import { VaultPicker } from '@/features/vault/VaultPicker'
import { VaultSettings } from '@/features/vault/VaultSettings'
import { syncLabel } from '../lib/sync-label'
import { trpc } from '../lib/trpc'
import { openTodaysDailyAtom, sweepDailyAtom } from '../state/daily'
import {
  activeTab,
  closeTab,
  openAgenda,
  openBoard,
  openMail,
  openPinned,
  openPreview,
  pinActive,
  pinTab,
  workspaceAtom,
} from '../state/panes'
import { sessionAtom } from '../state/session'
import { historyOpenAtom, historyTargetPathAtom, vaultLogOpenAtom } from '../state/history'
import { VaultHistory } from '@/features/history/VaultHistory'
import { useGoogleAccount } from '../state/google'
import { openTaskCountAtom, todayLinkCountAtom } from '../state/tasks'
import { openDialogAtom } from '../state/dialogs'
import { agentPanelOpenAtom } from '@/state/agent'
import { usePanelLayout } from '../state/preferences'
import { useVaultTheme } from '../state/theme'
import {
  activeRemoteAtom,
  heldBackAtom,
  openVaultAtom,
  reconcileAtom,
  syncStateAtom,
  vaultsAtom,
} from '../state/vaults'

// quiet/busy map to semantic tokens; warn stays a named amber utility — there is
// no warning token yet, and named palette utilities are gate-legal (only arbitrary
// colour literals are banned).
const TONE = { quiet: 'text-muted-foreground', busy: 'text-primary', warn: 'text-amber-400' } as const

/** The singleton tabs' pill text and tooltip. Notes use their filename/path and
 *  apps use their id instead — both are keyed by something the tab carries
 *  rather than by its kind, so neither can live in a lookup like this. */
const TAB_NAME = { board: 'board', agenda: 'agenda', mail: 'mail' } as const
const TAB_LABEL: Partial<Record<string, string>> = {
  board: 'task board',
  agenda: 'your Google agenda',
  mail: 'your Gmail',
}

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
  const session = useAtomValue(sessionAtom)
  const vaults = useAtomValue(vaultsAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const syncState = useAtomValue(syncStateAtom)
  const [workspace, setWorkspace] = useAtom(workspaceAtom)
  const setActiveRemote = useSetAtom(activeRemoteAtom)
  const openVault = useSetAtom(openVaultAtom)
  const openDaily = useSetAtom(openTodaysDailyAtom)
  const sweepDaily = useSetAtom(sweepDailyAtom)
  const setHistoryOpen = useSetAtom(historyOpenAtom)
  const historyOpen = useAtomValue(historyOpenAtom)
  const historyTarget = useAtomValue(historyTargetPathAtom)
  const [vaultLogOpen, setVaultLogOpen] = useAtom(vaultLogOpenAtom)
  const openDialog = useSetAtom(openDialogAtom)
  const openTaskCount = useAtomValue(openTaskCountAtom)
  const todayLinkCount = useAtomValue(todayLinkCountAtom)
  // Also the one place that asks main whether Google is connected at all — the
  // settings panel shares this atom rather than holding its own answer.
  const { account: googleAccount } = useGoogleAccount()
  const reconcile = useSetAtom(reconcileAtom)
  const [heldBack, setHeldBack] = useAtom(heldBackAtom)
  const setAgentOpen = useSetAtom(agentPanelOpenAtom)
  const shellLayout = usePanelLayout(activeRemote, 'shell')
  // Paint the active vault's colour/chrome theme onto the document root.
  useVaultTheme()
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
            setAgentOpen((layout.agent ?? 0) > 0)
          }}
        >
          <ResizablePanel id="nav" defaultSize={256} minSize={180} maxSize={440}>
            <aside className="relative flex h-full flex-col border-r border-border">
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

          {/* Below the tree and above the chips: an app is opened from a list of
              things the vault holds, like a file, not from the nav rail. Renders
              nothing at all until the vault has one. */}
          <AppsSection />

          {/* Two rows, not one. Five chips across a sidebar this narrow made it
              scroll horizontally — and `flex-1` alone could not fix that, since
              a flex item's default `min-width: auto` refuses to shrink below its
              text. `min-w-0` on each chip is what actually forbids the overflow;
              the split is what keeps them legible rather than truncated. */}
          <div className="flex flex-col gap-1.5 p-2">
            <div className="flex items-center gap-2">
              <Tooltip content="today's daily note (⌘⇧D)">
                <Button
                  variant="secondary"
                  size="xs"
                  className="min-w-0 flex-1 gap-1.5"
                  // FR-6: opens today's daily (personal vaults only; the atom no-ops
                  // otherwise). Also the empty-state recovery path — always here.
                  onClick={() => void openDaily()}
                >
                  today
                  {/* Open tasks linking to today's note (daily-notes §UX). Zero → no badge;
                      in a shared vault nothing links to the daily path, so it stays hidden. */}
                  {todayLinkCount > 0 && (
                    <span className="rounded-full bg-foreground/15 px-1.5 text-[10px] leading-4 text-foreground">
                      {todayLinkCount}
                    </span>
                  )}
                </Button>
              </Tooltip>
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
              <Tooltip content="vault settings">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 text-muted-foreground"
                  aria-label="vault settings"
                  onClick={() => setShowSettings((v) => !v)}
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
            <main className="flex h-full min-w-0 flex-col">
          {/* One pane, one strip. The state is panes[] → tabs[] so a split is a
              second pane later rather than a rewrite. */}
          <div className="flex h-11 items-center gap-1 px-2">
            {pane.tabs.map((t, i) => (
              <span
                key={t.kind === 'note' ? t.path : t.kind === 'app' ? `app:${t.appId}` : t.kind}
                className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs ${
                  i === pane.active
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Tooltip
                  content={
                    TAB_LABEL[t.kind] ??
                    (t.kind === 'note' ? t.path : t.kind === 'app' ? `the ${t.appId} app` : t.kind)
                  }
                >
                  <Button
                    variant="ghost"
                    // Bare clickable on the pill — neutralise the ghost bg/padding so
                    // the pill owns the surface. A preview tab reads italic (VS Code);
                    // double-clicking it pins it, the same promotion editing performs.
                    className={`h-auto gap-1.5 p-0 hover:bg-transparent ${
                      t.kind === 'note' && t.preview ? 'italic' : ''
                    }`}
                    onClick={() =>
                      setWorkspace((w) => ({
                        ...w,
                        panes: w.panes.map((p, pi) => (pi === w.active ? { ...p, active: i } : p)),
                      }))
                    }
                    onDoubleClick={() => setWorkspace((w) => pinTab(w, i))}
                  >
                    {/* The two kinds that carry data come first: `Tab`'s
                        singletons are ONE member (`{kind: SingletonTab}`), and a
                        member whose discriminant is a union of literals does not
                        reduce in the negative branch — so `t.path` is only
                        reachable by narrowing TO note, never by excluding the
                        rest. */}
                    {t.kind === 'note' ? (
                      fileIconFor(t.path)
                    ) : t.kind === 'app' ? (
                      <LayoutGrid size={14} />
                    ) : t.kind === 'agenda' ? (
                      <CalendarDays size={14} />
                    ) : t.kind === 'mail' ? (
                      <Mail size={14} />
                    ) : (
                      <SquareKanban size={14} />
                    )}
                    <span>
                      {t.kind === 'note'
                        ? t.path.split('/').at(-1)
                        : t.kind === 'app'
                          ? t.appId
                          : TAB_NAME[t.kind]}
                    </span>
                  </Button>
                </Tooltip>
                <Tooltip content="close tab">
                  <Button
                    variant="ghost"
                    className="h-auto p-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                    onClick={() => setWorkspace((w) => closeTab(w, i))}
                  >
                    ✕
                  </Button>
                </Tooltip>
              </span>
            ))}
            {/* Version history for the focused note — a header button toggling the
                right-hand drawer. `historyTargetPathAtom` is the one predicate the
                drawer also uses (a markdown note, not a task/image/pdf), so button
                and drawer never disagree. Mirrors how the agent panel opens. */}
            {historyTarget !== null && (
              <Tooltip content="version history">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto text-muted-foreground"
                  onClick={() => setHistoryOpen((v) => !v)}
                >
                  <History size={16} />
                </Button>
              </Tooltip>
            )}
          </div>

          {tab?.kind === 'app' ? (
            <AppFrame appId={tab.appId} />
          ) : tab?.kind === 'board' ? (
            <BoardView />
          ) : tab?.kind === 'agenda' ? (
            <AgendaView />
          ) : tab?.kind === 'mail' ? (
            <MailView />
          ) : tab?.kind === 'note' && fileKind(tab.path) === 'image' ? (
            <ImageViewer path={tab.path} />
          ) : tab?.kind === 'note' &&
            (fileKind(tab.path) === 'pdf' || fileKind(tab.path) === 'doc') ? (
            // Rich formats we can't yet render open a typed placeholder — a real
            // per-type viewer replaces it later (spec §Arbitrary files). Text
            // files (json/yaml/…) fall through to the plain editor below.
            <FilePlaceholder path={tab.path} kind={fileKind(tab.path) as 'pdf' | 'doc'} />
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
              // A non-markdown text file (.json/.yaml/.env/…) edits in the plain
              // stack — no wiki-links, no frontmatter, syntax highlighting by
              // extension. Markdown notes keep the full editor.
              plain={tab?.kind === 'note' && fileKind(tab.path) === 'text'}
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
                <VaultSettings
                  onClose={() => setShowSettings(false)}
                  connections={<GoogleConnection />}
                />
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
        <p className="border-t border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-[11px] text-amber-100">
          {banner}
        </p>
      )}

      {/* Sync state lives bottom-left: "where am I and is it saved elsewhere" is
          one glance. There is no Push button — push is automatic (D61) — so the
          footer only reports; sign out lives in settings. */}
      <footer className="flex items-center justify-between gap-3 border-t border-border px-3 py-1 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          {/* The sync state doubles as the entry to the whole-vault commit history
              (comment: "clickable — up to date opens version control"). */}
          <Tooltip content="version history">
            <Button
              variant="link"
              className={`h-auto p-0 truncate ${TONE[label.tone]}`}
              onClick={() => setVaultLogOpen(true)}
            >
              {label.text}
            </Button>
          </Tooltip>
          {/* The quiet footer affordance is for ordinary content conflicts; when a
              config file is among them the loud banner above owns the action, so
              this would be a redundant second reconcile button. */}
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
        <span className="shrink-0 truncate">
          {(activeRemote ?? 'no vault') + (session?.login ? ` · ${session.login}` : '')}
        </span>
      </footer>
    </div>
  )
}
