import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import {
  connectGithubAtom,
  connectRepoAtom,
  describeGitStatus,
  disconnectRepoAtom,
  githubLoginAtom,
  gitStatusAtom,
  loadGitStatusAtom,
  syncNowAtom,
} from '../state/git'
import { sessionAtom, signOutAtom } from '../state/session'

const toneClass = { idle: 'text-neutral-400', ok: 'text-emerald-400', error: 'text-red-400' } as const

export function VaultSettings({ onClose }: { onClose: () => void }) {
  const status = useAtomValue(gitStatusAtom)
  const githubLogin = useAtomValue(githubLoginAtom)
  const load = useSetAtom(loadGitStatusAtom)
  const connectGithub = useSetAtom(connectGithubAtom)
  const connectRepo = useSetAtom(connectRepoAtom)
  const disconnect = useSetAtom(disconnectRepoAtom)
  const syncNow = useSetAtom(syncNowAtom)
  const session = useAtomValue(sessionAtom)
  const signOut = useSetAtom(signOutAtom)
  const [repoUrl, setRepoUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = describeGitStatus(status)

  useEffect(() => {
    void load()
  }, [load])

  const guard = (fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Settings</h2>
        <button className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700" onClick={onClose}>
          close
        </button>
      </div>

      {/* The members section is gone with the membership system it drove — invites,
          roles and transfer-ownership were server rules, and GitHub owns access now
          (D60 §9). Its replacement is a READ-ONLY collaborators panel over the repo's
          collaborator list, built with the device-flow auth it depends on. */}

      <section className="space-y-1">
        <h3 className="font-medium">GitHub account</h3>
        {githubLogin ? (
          <p className="text-neutral-400">
            Linked as <span className="text-neutral-200">{githubLogin}</span>
          </p>
        ) : (
          <button
            disabled={busy}
            className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700 disabled:opacity-50"
            onClick={guard(() => connectGithub())}
          >
            Connect GitHub…
          </button>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">Repository</h3>
        <p className={toneClass[view.tone]}>{view.label}</p>
        {status ? (
          <div className="flex gap-2">
            <span className="text-neutral-400">{status.repoUrl}</span>
            <button disabled={busy} className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700" onClick={guard(() => syncNow())}>
              sync now
            </button>
            <button disabled={busy} className="rounded bg-red-900 px-2 py-1 hover:bg-red-800" onClick={guard(() => disconnect())}>
              disconnect
            </button>
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void guard(() => connectRepo(repoUrl))()
            }}
          >
            <input
              className="w-80 rounded border border-neutral-800 bg-neutral-900 px-2 py-1"
              placeholder="https://github.com/org/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            <button disabled={busy || !githubLogin} className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700 disabled:opacity-50">
              Connect repository
            </button>
          </form>
        )}
        {!githubLogin && !status && (
          <p className="text-xs text-neutral-500">
            Connecting a repo installs a deploy key + webhook on it (your GitHub account authorizes this once; day-to-day
            sync uses the deploy key). Notes, tasks, .claude/ and .holi/settings.json are all mirrored — everything except
            your machine-local files (USER.md and any *.local.* file).
          </p>
        )}
        {status && status.warnings.length > 0 && (
          <ul className="space-y-1 text-xs text-amber-400">
            {status.warnings.slice(0, 10).map((w, i) => (
              <li key={i}>
                {w.kind}: {w.path} {w.detail ?? ''}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </section>

      {/* Account actions live here, not in the footer: the footer reports state, it does
        * not act — and sign out is the one destructive control in the shell. */}
      <section className="mt-auto space-y-2 border-t border-neutral-900 pt-4">
        <h3 className="font-medium">Account</h3>
        <div className="flex items-center justify-between">
          <p className="text-neutral-400">{session?.email}</p>
          <button
            className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </section>
    </div>
  )
}
