/**
 * How a vault gets into the list in the first place (FR-7, FR-8).
 *
 * Both router procedures existed, were tested, and had no caller at all — the
 * shell listed vaults and opened them, and offered no way for one to arrive.
 * Signing in on a clean machine produced an empty dropdown and nothing to
 * press.
 *
 * Two routes, one panel: adopt a repo you already have, or make a new private
 * one. Nothing else — Holi does not implement invitation, so "join a vault" is
 * someone adding you as a collaborator on GitHub and you adopting it here.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import type { Repo } from '../../../main/github/api'
import { trpc } from '../lib/trpc'
import { sessionAtom } from '../state/session'
import { addVaultAtom, createVaultAtom, vaultsAtom } from '../state/vaults'

export function AddVault({ onClose }: { onClose: () => void }) {
  const session = useAtomValue(sessionAtom)
  const known = useAtomValue(vaultsAtom)
  const addVault = useSetAtom(addVaultAtom)
  const createVault = useSetAtom(createVaultAtom)
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [search, setSearch] = useState('')
  const [newName, setNewName] = useState('')
  const [owner, setOwner] = useState<string>(session?.login ?? '')
  const [orgs, setOrgs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void trpc.github.repos
      .query()
      .then(setRepos)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    // FR-3: `read:org` buys exactly one feature — offering an org as the owner
    // of a new vault. If it fails, the personal account still works.
    void trpc.github.orgs
      .query()
      .then((list) => setOrgs(list.map((o) => o.login)))
      .catch(() => {})
  }, [])

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    fn()
      .then(onClose)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const alreadyAdded = new Set(known.map((v) => v.remote))
  const matches = (repos ?? [])
    .filter((r) => r.remote.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 40)

  return (
    <div className="absolute inset-x-2 top-12 z-10 rounded border border-neutral-800 bg-neutral-900 p-3 text-xs shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-medium text-neutral-200">Add a vault</h3>
        <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose}>
          ✕
        </button>
      </div>

      <input
        autoFocus
        className="mb-2 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1"
        placeholder="search your repos…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="holi-scroll max-h-56 overflow-y-auto">
        {repos === null && error === null && <p className="text-neutral-500">loading repos…</p>}
        {matches.map((repo) => {
          const added = alreadyAdded.has(repo.remote)
          return (
            <button
              key={repo.remote}
              disabled={busy || added || !repo.canPush}
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-neutral-800 disabled:opacity-40"
              onClick={() => run(() => addVault(repo.remote))}
              // A repo you cannot push to becomes a vault that silently fails
              // to publish, which is the worst way to find out.
              title={added ? 'already added' : repo.canPush ? '' : 'you cannot push to this repo'}
            >
              <span className="min-w-0 flex-1 truncate text-neutral-200">{repo.remote}</span>
              {repo.visibility !== 'private' && (
                <span className="shrink-0 text-amber-400">{repo.visibility}</span>
              )}
              {added && <span className="shrink-0 text-neutral-600">added</span>}
            </button>
          )
        })}
        {repos !== null && matches.length === 0 && (
          <p className="text-neutral-500">no repos match</p>
        )}
      </div>

      <form
        className="mt-3 flex items-center gap-1 border-t border-neutral-800 pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          const name = newName.trim()
          if (name && owner) run(() => createVault({ name, owner }))
        }}
      >
        <select
          className="rounded border border-neutral-800 bg-neutral-950 px-1 py-1"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        >
          {session && <option value={session.login}>{session.login}</option>}
          {orgs.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <input
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1"
          placeholder="new-vault-name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          disabled={busy || !newName.trim()}
          className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700 disabled:opacity-40"
        >
          create
        </button>
      </form>
      <p className="mt-1 text-[10px] text-neutral-600">
        New vaults are private. Share one by adding collaborators on GitHub.
      </p>

      {error !== null && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
    </div>
  )
}
