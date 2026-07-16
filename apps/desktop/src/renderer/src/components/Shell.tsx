import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { AgentPanel } from './AgentPanel'
import { BoardView } from './BoardView'
import { EditorPane } from './EditorPane'
import { FileTree } from './FileTree'
import { VaultSettings } from './VaultSettings'
import { agentPanelOpenAtom, agentStatusAtom } from '../state/agent'
import { openTodaysDailyNoteAtom, sweepDailyNotesAtom } from '../state/daily'
import { sessionAtom, signOutAtom } from '../state/session'
import { syncStatusAtom } from '../state/sync'
import {
  activeDocAtom,
  activeVaultIdAtom,
  createVaultAtom,
  loadDocsAtom,
  loadVaultsAtom,
  vaultsAtom,
} from '../state/vaults'

export function Shell() {
  const session = useAtomValue(sessionAtom)
  const signOut = useSetAtom(signOutAtom)
  const vaults = useAtomValue(vaultsAtom)
  const [activeVaultId, setActiveVaultId] = useAtom(activeVaultIdAtom)
  const activeDoc = useAtomValue(activeDocAtom)
  const setActiveDoc = useSetAtom(activeDocAtom)
  const syncStatus = useAtomValue(syncStatusAtom)
  const loadVaults = useSetAtom(loadVaultsAtom)
  const loadDocs = useSetAtom(loadDocsAtom)
  const createVault = useSetAtom(createVaultAtom)
  const openTodaysDailyNote = useSetAtom(openTodaysDailyNoteAtom)
  const sweepDailyNotes = useSetAtom(sweepDailyNotesAtom)
  const [newVaultName, setNewVaultName] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [view, setView] = useState<'notes' | 'board'>('notes')
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
                {view === 'notes' && activeDoc && (
                  <span className="ml-2 truncate text-xs text-neutral-500">{activeDoc.path}</span>
                )}
              </div>
              {view === 'board' ? <BoardView /> : <EditorPane />}
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
        <span className="flex items-center gap-2">
          {session?.email}
          <button className="rounded px-1 hover:bg-neutral-900" onClick={() => void signOut()}>
            sign out
          </button>
        </span>
      </footer>
    </div>
  )
}
