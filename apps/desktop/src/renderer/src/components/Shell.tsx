import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { AgentPanel } from './AgentPanel'
import { BoardView } from './BoardView'
import { EditorPane } from './EditorPane'
import { FileTree } from './FileTree'
import { HistoryPanel } from './HistoryPanel'
import { VaultSettings } from './VaultSettings'
import { agentPanelOpenAtom, agentStatusAtom } from '../state/agent'
import { historyOpenAtom } from '../state/history'
import { openTodaysDailyNoteAtom, sweepDailyNotesAtom } from '../state/daily'
import { sessionAtom } from '../state/session'
import { agentEditingAtom, syncStatusAtom } from '../state/sync'
import { useTaskFeed } from '../state/task-feed'
import { selectedTaskIdAtom } from '../state/tasks'
import { viewAtom } from '../state/view'
import {
  activeDocAtom,
  activeVaultIdAtom,
  applyDocsEventAtom,
  createVaultAtom,
  loadDocsAtom,
  loadVaultsAtom,
  vaultsAtom,
} from '../state/vaults'

export function Shell() {
  const session = useAtomValue(sessionAtom)
  const vaults = useAtomValue(vaultsAtom)
  const [activeVaultId, setActiveVaultId] = useAtom(activeVaultIdAtom)
  const activeDoc = useAtomValue(activeDocAtom)
  const setActiveDoc = useSetAtom(activeDocAtom)
  const syncStatus = useAtomValue(syncStatusAtom)
  const agentEditing = useAtomValue(agentEditingAtom)
  // Tasks live at the shell, beside the docs feed below: the board renders them, but so
  // does the notes editor (task chips, `@`-mention), and it must not depend on the board
  // having been opened first.
  useTaskFeed()
  const loadVaults = useSetAtom(loadVaultsAtom)
  const loadDocs = useSetAtom(loadDocsAtom)
  const createVault = useSetAtom(createVaultAtom)
  const openTodaysDailyNote = useSetAtom(openTodaysDailyNoteAtom)
  const sweepDailyNotes = useSetAtom(sweepDailyNotesAtom)
  const setSelectedTaskId = useSetAtom(selectedTaskIdAtom)
  const applyDocsEvent = useSetAtom(applyDocsEventAtom)
  const [historyOpen, setHistoryOpen] = useAtom(historyOpenAtom)
  const [newVaultName, setNewVaultName] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [view, setView] = useAtom(viewAtom)
  const setAgentOpen = useSetAtom(agentPanelOpenAtom)
  const agentStatus = useAtomValue(agentStatusAtom)
  /** A vault switch mid-turn kills the session — hold the choice until confirmed. */
  const [pendingVaultId, setPendingVaultId] = useState<string | null>(null)

  useEffect(() => {
    void loadVaults()
  }, [loadVaults])
  useEffect(() => {
    if (activeVaultId) void window.holi.vault.activate(activeVaultId)
    setActiveDoc(null)
    void (async () => {
      await loadDocs()
      // A personal vault lands you on today's daily note; both calls no-op on a shared
      // one. The sweep is deliberately not awaited — archiving yesterday must never
      // delay opening the note you came here to write in, and it retries next time.
      await openTodaysDailyNote()
      void sweepDailyNotes()
    })()
  }, [activeVaultId, loadDocs, setActiveDoc, openTodaysDailyNote, sweepDailyNotes])

  // A clicked reminder notification lands you on the task it was about. Mounted here,
  // not in BoardView: the board may well not be on screen when the notification fires —
  // that is the whole point of a reminder.
  useEffect(() => {
    return window.holi.reminders.onOpen(({ vaultId, taskId }) => {
      // The fire may be for a vault you do not have open — that is what the user-scoped
      // stream bought (D48/D52), and without switching, the click would select a task id
      // against the wrong board and appear to do nothing. Jotai bails on an unchanged
      // value, so this is a no-op when it is already the active vault; when it is not,
      // the activation effect above does the rest.
      //
      // Deliberately not routed through selectVault's mid-edit guard: clicking a
      // reminder is an explicit instruction to go to that task, where the guard exists to
      // catch an accidental switch from the dropdown.
      setActiveVaultId(vaultId)
      setView('board')
      // A coalesced summary speaks for several tasks and carries no id — landing you on
      // the right board is the whole action.
      if (taskId) setSelectedTaskId(taskId)
    })
  }, [setView, setSelectedTaskId, setActiveVaultId])

  // The tree, the switcher, and recovery after a gap. Mounted here rather than in
  // FileTree: main pushes these whether or not the tree is rendered, and a listener that
  // only exists while a component is mounted would drop them.
  useEffect(() => {
    const offDocs = window.holi.docs.onEvent((e) => applyDocsEvent(e))
    // You were invited somewhere, or removed. Refetch rather than patch a Vault in: on
    // `left` you can no longer read the vault, so there is nothing to patch (D51).
    const offVaults = window.holi.vaults.onEvent(() => void loadVaults())
    // There is no resume cursor on the wire, so a gap is the one moment the tree and the
    // switcher can silently go stale on exactly the path this all exists to fix. Main's
    // mirror and projector reconcile themselves; these two have nothing but a refetch.
    const offResync = window.holi.stream.onResync(() => {
      void loadVaults()
      void loadDocs()
    })
    return () => {
      offDocs()
      offVaults()
      offResync()
    }
  }, [applyDocsEvent, loadVaults, loadDocs])

  // ⌘J / Ctrl-J toggles the agent drawer (the app's first shortcut)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setAgentOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setAgentOpen])

  // the agent's per-turn context follows what the user is looking at
  useEffect(() => {
    void window.holi.agent.setFocus({
      focusedPath: activeDoc?.path ?? null,
      openPaths: activeDoc ? [activeDoc.path] : [],
    })
  }, [activeDoc])

  const selectVault = (vaultId: string) => {
    if (agentStatus.working) setPendingVaultId(vaultId) // Claude is mid-edit
    else setActiveVaultId(vaultId)
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 flex-col border-r border-neutral-900">
          <div className="flex items-center gap-1 p-2">
            <select
              className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
              value={activeVaultId ?? ''}
              onChange={(e) => selectVault(e.target.value)}
            >
              {vaults.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button
              className="rounded bg-neutral-800 px-2 py-1 text-sm hover:bg-neutral-700"
              title="new shared vault"
              onClick={() => setNewVaultName((v) => (v === null ? '' : null))}
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
          {pendingVaultId !== null && (
            <div className="mx-2 mb-2 rounded border border-amber-900/60 bg-amber-950/40 p-2 text-xs text-amber-100">
              <p>Claude is mid-edit — switching vaults kills the session.</p>
              <div className="mt-1.5 flex gap-2">
                <button
                  className="rounded bg-amber-800 px-2 py-0.5 hover:bg-amber-700"
                  onClick={() => {
                    setActiveVaultId(pendingVaultId)
                    setPendingVaultId(null)
                  }}
                >
                  switch anyway
                </button>
                <button
                  className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700"
                  onClick={() => setPendingVaultId(null)}
                >
                  stay
                </button>
              </div>
            </div>
          )}
          {newVaultName !== null && (
            <form
              className="px-2 pb-2"
              onSubmit={(e) => {
                e.preventDefault()
                const name = newVaultName.trim()
                if (name) {
                  void createVault(name)
                  setNewVaultName(null)
                }
              }}
            >
              <input
                autoFocus
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
                placeholder="new vault name…"
                value={newVaultName}
                onChange={(e) => setNewVaultName(e.target.value)}
              />
            </form>
          )}
          <FileTree />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          {showSettings ? (
            <VaultSettings onClose={() => setShowSettings(false)} />
          ) : (
            <>
              <div className="flex items-center gap-1 border-b border-neutral-900 px-3 py-1.5">
                {(['notes', 'board'] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`rounded px-2 py-0.5 text-xs capitalize ${
                      view === v
                        ? 'bg-neutral-800 text-neutral-100'
                        : 'text-neutral-500 hover:text-neutral-300'
                    }`}
                  >
                    {v}
                  </button>
                ))}
                {/* The open note names the surface you're on — it reads at the same
                  * weight as the selected toggle, with its folder path kept quiet. */}
                {view === 'notes' && activeDoc && (
                  <span className="ml-2 min-w-0 truncate text-xs text-neutral-100">
                    {activeDoc.path.includes('/') && (
                      <span className="text-neutral-500">
                        {activeDoc.path.slice(0, activeDoc.path.lastIndexOf('/') + 1)}
                      </span>
                    )}
                    {activeDoc.path.slice(activeDoc.path.lastIndexOf('/') + 1)}
                  </span>
                )}
                {/* D37's marker, finally rendered — the agent's system prompt has always
                  * told it this was on screen. It sits on the note's name because that is
                  * what it is about: an agent is writing to THIS doc, right now. */}
                {view === 'notes' && activeDoc && agentEditing && (
                  <span className="ml-2 shrink-0 animate-pulse text-xs text-amber-400">
                    Claude is editing…
                  </span>
                )}
                {/* History is about the open note, so it belongs beside its name. */}
                {view === 'notes' && activeDoc && (
                  <button
                    onClick={() => setHistoryOpen((v) => !v)}
                    title="version history"
                    className={`ml-auto rounded px-2 py-0.5 text-xs ${
                      historyOpen
                        ? 'bg-neutral-800 text-neutral-100'
                        : 'text-neutral-500 hover:text-neutral-300'
                    }`}
                  >
                    history
                  </button>
                )}
              </div>
              <div className="flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col">
                  {view === 'board' ? <BoardView /> : <EditorPane />}
                </div>
                {view === 'notes' && <HistoryPanel />}
              </div>
            </>
          )}
        </main>
        <AgentPanel />
      </div>
      <footer className="flex items-center justify-between border-t border-neutral-900 px-3 py-1 text-xs text-neutral-500">
        <span>
          <span
            className={
              syncStatus === 'synced'
                ? 'text-green-400'
                : syncStatus === 'syncing'
                  ? 'text-yellow-400'
                  : 'text-neutral-500'
            }
          >
            ●
          </span>{' '}
          {syncStatus}
        </span>
        {/* Sign out lives in settings — the footer states who you are, it does not act. */}
        <span>{session?.email}</span>
      </footer>
    </div>
  )
}
