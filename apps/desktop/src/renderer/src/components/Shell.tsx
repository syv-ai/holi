import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { EditorPane } from './EditorPane'
import { FileTree } from './FileTree'
import { VaultSettings } from './VaultSettings'
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
  const [newVaultName, setNewVaultName] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    void loadVaults()
  }, [loadVaults])
  useEffect(() => {
    if (activeVaultId) void window.holi.vault.activate(activeVaultId)
    setActiveDoc(null)
    void loadDocs()
  }, [activeVaultId, loadDocs, setActiveDoc])

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 flex-col border-r border-neutral-900">
          <div className="flex items-center gap-1 p-2">
            <select
              className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
              value={activeVaultId ?? ''}
              onChange={(e) => setActiveVaultId(e.target.value)}
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
              {activeDoc && (
                <div className="truncate border-b border-neutral-900 px-4 py-2 text-xs text-neutral-400">
                  {activeDoc.path}
                </div>
              )}
              <EditorPane />
            </>
          )}
        </main>
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
