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
 * The agent drawer is plan 6; the history panel and daily notes are plan 7.
 * There is deliberately no ⌘J: a shortcut that toggles a drawer which does not
 * exist is worse than no shortcut.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { AddVault } from './AddVault'
import { BoardView } from './BoardView'
import { EditorPane } from './EditorPane'
import { FileTree } from './FileTree'
import { VaultSettings } from './VaultSettings'
import { syncLabel } from '../lib/sync-label'
import { trpc } from '../lib/trpc'
import { openTodaysDailyAtom, sweepDailyAtom } from '../state/daily'
import {
  activeTab,
  closeTab,
  openPinned,
  openPreview,
  openTab,
  pinActive,
  pinTab,
  workspaceAtom,
} from '../state/panes'
import { sessionAtom } from '../state/session'
import {
  activeRemoteAtom,
  loadVaultsAtom,
  openVaultAtom,
  syncStateAtom,
  vaultsAtom,
} from '../state/vaults'

const TONE = { quiet: 'text-neutral-500', busy: 'text-sky-400', warn: 'text-amber-400' } as const

export function Shell() {
  const session = useAtomValue(sessionAtom)
  const vaults = useAtomValue(vaultsAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const syncState = useAtomValue(syncStateAtom)
  const [workspace, setWorkspace] = useAtom(workspaceAtom)
  const loadVaults = useSetAtom(loadVaultsAtom)
  const openVault = useSetAtom(openVaultAtom)
  const openDaily = useSetAtom(openTodaysDailyAtom)
  const sweepDaily = useSetAtom(sweepDailyAtom)
  const [showSettings, setShowSettings] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  /** The vault we last ran the daily create+sweep for, so opening it does not
   *  re-land you on today's note every render. */
  const lastDailyRemote = useRef<string | null>(null)

  useEffect(() => {
    void loadVaults()
  }, [loadVaults])

  // FR-4/FR-5: on personal-vault open, land on today's note then sweep prior
  // days. Both no-op for shared vaults. Once per remote.
  useEffect(() => {
    if (!activeRemote || lastDailyRemote.current === activeRemote) return
    lastDailyRemote.current = activeRemote
    void openDaily().then(() => sweepDaily())
  }, [activeRemote, openDaily, sweepDaily])

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

  const tab = activeTab(workspace)
  const pane = workspace.panes[workspace.active]!
  const label = syncLabel(syncState)
  // Single-click / link-nav opens a preview tab (browsing costs one tab);
  // double-click pins. Editing a preview promotes it (see EditorPane onEdit).
  const open = (path: string) => setWorkspace((w) => openPreview(w, path))
  const openPin = (path: string) => setWorkspace((w) => openPinned(w, path))

  /** A vault switch is a teardown in main — the old watcher and timers stop —
   *  so the tabs over the old vault have to go with it. */
  const switchVault = (remote: string) => {
    setWorkspace(() => ({ panes: [{ tabs: [], active: -1 }], active: 0 }))
    setBanner(null)
    void openVault(remote)
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="flex min-h-0 flex-1">
        <aside className="relative flex w-64 flex-col border-r border-neutral-900">
          <div className="flex items-center gap-1 p-2">
            <select
              className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
              value={activeRemote ?? ''}
              onChange={(e) => switchVault(e.target.value)}
            >
              {vaults.length === 0 && <option value="">no vaults</option>}
              {vaults.map((v) => (
                <option key={v.remote} value={v.remote}>
                  {v.name}
                </option>
              ))}
            </select>
            <button
              className="rounded bg-neutral-800 px-2 py-1 text-sm hover:bg-neutral-700"
              title="add or create a vault"
              onClick={() => setShowAdd((v) => !v)}
            >
              +
            </button>
            <button
              className="rounded bg-neutral-800 px-2 py-1 text-sm hover:bg-neutral-700"
              title="vault settings"
              onClick={() => setShowSettings((v) => !v)}
            >
              ⚙
            </button>
          </div>
          {showAdd && <AddVault onClose={() => setShowAdd(false)} />}

          {/* FR-21 puts the state beside the vault name, because that is where
              you look to know which vault you are in. */}
          <div className="flex items-center justify-between px-3 pb-2">
            <span className={`text-[11px] ${TONE[label.tone]}`}>{label.text}</span>
            <button
              className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] hover:bg-neutral-700"
              onClick={() => {
                setBanner(null)
                void trpc.sync.publish
                  .mutate()
                  .then((r) => {
                    // FR-15: a conflicting pre-publish pull pushes nothing and
                    // leaves the work local and intact. Calling that "publish
                    // failed" would imply something was lost.
                    if (r.kind === 'conflict') {
                      setBanner(`${r.paths.length} files conflict — nothing was published`)
                    }
                  })
                  .catch((err: unknown) =>
                    setBanner(err instanceof Error ? err.message : String(err)),
                  )
              }}
            >
              publish
            </button>
          </div>
          {banner !== null && (
            <p className="mx-2 mb-2 rounded border border-amber-900/60 bg-amber-950/40 p-2 text-[11px] text-amber-100">
              {banner}
            </p>
          )}

          <FileTree
            activePath={tab?.kind === 'note' ? tab.path : null}
            onOpenPreview={open}
            onOpenPinned={openPin}
          />

          <div className="flex gap-2 p-2">
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
              className="flex-1 rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
              onClick={() => setWorkspace((w) => openTab(w, { kind: 'board' }))}
            >
              board
            </button>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {/* One pane, one strip. The state is panes[] → tabs[] so a split is a
              second pane later rather than a rewrite. */}
          <div className="flex items-center gap-1 border-b border-neutral-900 px-2 py-1">
            {pane.tabs.map((t, i) => (
              <span
                key={t.kind === 'note' ? t.path : 'board'}
                className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
                  i === pane.active
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                <button
                  // A preview tab reads italic (VS Code); double-clicking it
                  // pins it, the same promotion editing performs.
                  className={t.kind === 'note' && t.preview ? 'italic' : undefined}
                  onClick={() =>
                    setWorkspace((w) => ({
                      ...w,
                      panes: w.panes.map((p, pi) => (pi === w.active ? { ...p, active: i } : p)),
                    }))
                  }
                  onDoubleClick={() => setWorkspace((w) => pinTab(w, i))}
                >
                  {t.kind === 'board' ? 'board' : t.path.split('/').at(-1)}
                </button>
                <button
                  className="text-neutral-600 hover:text-neutral-300"
                  onClick={() => setWorkspace((w) => closeTab(w, i))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>

          {tab?.kind === 'board' ? (
            <BoardView />
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

        {showSettings && <VaultSettings onClose={() => setShowSettings(false)} />}
      </div>

      <footer className="flex items-center justify-between border-t border-neutral-900 px-3 py-1 text-xs text-neutral-500">
        <span>{activeRemote ?? 'no vault'}</span>
        {/* Sign out lives in settings — the footer states who you are, it does
            not act. */}
        <span>{session?.login}</span>
      </footer>
    </div>
  )
}
