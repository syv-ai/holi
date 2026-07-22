/**
 * What this vault is, and who can see it.
 *
 * **Read-only, on purpose.** The old panel drove a connect-a-repo flow that
 * installed a deploy key and a webhook, plus invites, roles and
 * transfer-ownership — all server rules, and GitHub owns access now. Holi does
 * not implement invitation (FR-11); it points at the flow that does.
 *
 * Visibility arrives with the members rather than from a second call this panel
 * could forget to make. `router.ts` says why: a vault silently becoming public
 * is the highest-severity thing that can happen to it, and this is the only
 * surface that would ever show it.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import type { Collaborator } from '@holi/shared'
import { trpc } from '../lib/trpc'
import { sessionAtom, signOutAtom } from '../state/session'
import { activeRemoteAtom, vaultsAtom } from '../state/vaults'

/** Mirrors `remoteUrl` in `main/git.ts`, minus the `.git` — this one is for a
 *  human to click, not for git to clone. A vault whose origin is a local path
 *  (a test fixture) still renders its remote; the link simply will not resolve,
 *  which is the honest outcome for a vault that is not on GitHub. */
const originUrl = (remote: string) => `https://github.com/${remote}`

export function VaultSettings({ onClose }: { onClose: () => void }) {
  const remote = useAtomValue(activeRemoteAtom)
  const entry = useAtomValue(vaultsAtom).find((v) => v.remote === remote)
  const session = useAtomValue(sessionAtom)
  const signOut = useSetAtom(signOutAtom)
  const [members, setMembers] = useState<{
    visibility: string
    collaborators: Collaborator[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (remote === null) return
    setError(null)
    void trpc.github.collaborators
      .query({ remote })
      .then(setMembers)
      // A refusal here is ordinary — no network, or a token without the scope —
      // and the panel says so rather than rendering an empty member list, which
      // would read as "nobody else has access".
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [remote])

  return (
    <div className="flex h-full w-80 flex-col gap-4 border-l border-neutral-900 p-4 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Settings</h2>
        <button className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700" onClick={onClose}>
          close
        </button>
      </div>

      <section className="space-y-1">
        <h3 className="font-medium">Vault</h3>
        {entry === undefined ? (
          <p className="text-neutral-400">no vault open</p>
        ) : (
          <>
            {/* Where it actually points. A vault IS its remote, and until now
                nothing in the app said which one — you could not tell a vault
                backed by GitHub from one backed by a local fixture. */}
            <button
              className="block max-w-full truncate text-left text-sky-400 hover:underline"
              title={originUrl(entry.remote)}
              onClick={() => void window.holi.openExternal(originUrl(entry.remote))}
            >
              {entry.remote}
            </button>
            {/* FR-15 promises the clones survive a sign-out and that the user is
                told where they are. This is where they are told. */}
            <p className="truncate text-[11px] text-neutral-500" title={entry.path}>
              {entry.path}
            </p>
          </>
        )}
        {members && (
          <p className={members.visibility === 'public' ? 'text-amber-400' : 'text-neutral-500'}>
            {members.visibility}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">Collaborators</h3>
        {error !== null && <p className="text-xs text-red-400">{error}</p>}
        {members === null && error === null && <p className="text-xs text-neutral-500">loading…</p>}
        <ul className="space-y-1 text-neutral-400">
          {members?.collaborators.map((c) => (
            <li key={c.accountId}>{c.login}</li>
          ))}
        </ul>
        <button
          disabled={remote === null}
          className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700 disabled:opacity-50"
          onClick={() => {
            if (remote !== null) void trpc.github.openCollaboratorSettings.mutate({ remote })
          }}
        >
          Manage on GitHub…
        </button>
      </section>

      {/* Account actions live here, not in the footer: the footer reports state,
        * it does not act — and sign out is the one destructive control here. */}
      <section className="mt-auto space-y-2 border-t border-neutral-900 pt-4">
        <h3 className="font-medium">Account</h3>
        <div className="flex items-center justify-between">
          <p className="text-neutral-400">{session?.login}</p>
          <button
            className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
            // FR-15: this drops the keychain entry and leaves every clone where
            // it is. Removing a vault is a separate, deliberate act.
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </section>
    </div>
  )
}
