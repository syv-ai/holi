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
import { SiGithub } from '@icons-pack/react-simple-icons'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import type { Collaborator } from '@holi/shared'
import { collaboratorsErrorText, errorCodeOf } from '../lib/collaborators-error'
import { trpc } from '../lib/trpc'
import { sessionAtom, signOutAtom } from '../state/session'
import { activeRemoteAtom, vaultsAtom } from '../state/vaults'

/** Mirrors `remoteUrl` in `main/git.ts`, minus the `.git` — this one is for a
 *  human to click, not for git to clone. A vault whose origin is a local path
 *  (a test fixture) still renders its remote; the link simply will not resolve,
 *  which is the honest outcome for a vault that is not on GitHub. */
const originUrl = (remote: string) => `https://github.com/${remote}`

/** A collaborator's — or the signed-in user's — GitHub profile. Same honesty
 *  caveat as `originUrl`: a login is always a real GitHub account, so this
 *  always resolves. */
const userUrl = (login: string) => `https://github.com/${login}`

/** The clone path, shortened for display. A vault always lives at
 *  `<managed-root>/<owner>/<repo>`, and the tail is exactly the remote — so the
 *  segment before it is the managed root's own folder (`Holi`). Show from there,
 *  dropping the long home-directory prefix. The full path stays in the tooltip
 *  and still drives the Finder reveal. */
const displayLocalPath = (fullPath: string, remote: string): string => {
  const parts = fullPath.split('/')
  const rootLeaf = parts[parts.length - remote.split('/').length - 1]
  return rootLeaf ? `${rootLeaf}/${remote}` : fullPath
}

/** The GitHub brand mark, from simple-icons — lucide carries no brand glyphs.
 *  `color="currentColor"` lets it inherit the button's text colour. */
function GitHubMark() {
  return <SiGithub size={13} color="currentColor" aria-hidden="true" />
}

export function VaultSettings({ onClose }: { onClose: () => void }) {
  const remote = useAtomValue(activeRemoteAtom)
  const entry = useAtomValue(vaultsAtom).find((v) => v.remote === remote)
  const session = useAtomValue(sessionAtom)
  const signOut = useSetAtom(signOutAtom)
  const [members, setMembers] = useState<{
    visibility: string
    collaborators: Collaborator[]
  } | null>(null)
  /** The sentence to show, plus the raw refusal for the tooltip — kept together
   *  so they can never describe two different failures. */
  const [error, setError] = useState<{ text: string; raw: string } | null>(null)

  useEffect(() => {
    if (remote === null) return
    setError(null)
    setMembers(null)
    void trpc.github.collaborators
      .query({ remote })
      .then(setMembers)
      // A refusal here is ordinary — a vault that is not on GitHub, no network,
      // or a token without the scope — and *which* one decides what the user
      // should do about it. The panel says so rather than rendering an empty
      // member list, which would read as "nobody else has access".
      .catch((err: unknown) =>
        setError({
          text: collaboratorsErrorText(errorCodeOf(err), remote),
          raw: err instanceof Error ? err.message : String(err),
        }),
      )
  }, [remote])

  return (
    <div className="flex h-full flex-col gap-4 p-4 text-sm">
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
            {/* Where the vault points, and where its clone lives on disk. Each
                value sits on its own line under a small label so a long remote
                or path has the full panel width before it truncates. A vault IS
                its remote (until now nothing said which one); the local path is
                the clone FR-15 promises survives a sign-out. Both are links: the
                remote opens GitHub, the path reveals the folder in Finder. */}
            <div className="space-y-2">
              <div className="space-y-0.5">
                <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                  Remote
                </div>
                <button
                  className="block max-w-full truncate text-left text-sky-400 hover:underline"
                  title={originUrl(entry.remote)}
                  onClick={() => void window.holi.openExternal(originUrl(entry.remote))}
                >
                  {entry.remote}
                </button>
              </div>
              <div className="space-y-0.5">
                <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                  Local
                </div>
                <button
                  className="block max-w-full truncate text-left text-sky-400 hover:underline"
                  title={entry.path}
                  onClick={() => void window.holi.openPath(entry.path)}
                >
                  {displayLocalPath(entry.path, entry.remote)}
                </button>
              </div>
            </div>
          </>
        )}
        {members && (
          <p className={members.visibility === 'public' ? 'text-amber-400' : 'text-neutral-500'}>
            {members.visibility}
          </p>
        )}
      </section>

      <section className="space-y-2">
        {/* Manage sits inline with the header, subtle and right-aligned — Holi
            does not implement invitation (FR-11), it just points at the flow
            that does, so the control is a quiet deep-link, not a primary action. */}
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Collaborators</h3>
          <button
            disabled={remote === null}
            className="flex items-center gap-1.5 text-xs text-neutral-500 transition-colors hover:text-neutral-300 disabled:pointer-events-none disabled:opacity-40"
            onClick={() => {
              if (remote !== null) void trpc.github.openCollaboratorSettings.mutate({ remote })
            }}
          >
            Manage…
            <GitHubMark />
          </button>
        </div>
        {/* A refusal is ordinary (signed out, no scope, local-fixture vault) and
            the copy names which one — a bare GitHub "Not Found" reads like a
            crash, and the old catch-all blamed sign-in for all four. The raw
            message stays in the tooltip. */}
        {error !== null && (
          <p className="text-xs text-neutral-500" title={error.raw}>
            {error.text}
          </p>
        )}
        {members === null && error === null && <p className="text-xs text-neutral-500">loading…</p>}
        <ul className="space-y-1">
          {members?.collaborators.map((c) => (
            <li key={c.accountId}>
              {/* Each collaborator links to their GitHub profile. */}
              <button
                className="text-neutral-400 transition-colors hover:text-sky-400 hover:underline"
                title={userUrl(c.login)}
                onClick={() => void window.holi.openExternal(userUrl(c.login))}
              >
                {c.login}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Account actions live here, not in the footer: the footer reports state,
        * it does not act — and sign out is the one destructive control here. */}
      <section className="mt-auto space-y-2 border-t border-neutral-900 pt-4">
        <h3 className="font-medium">Account</h3>
        <div className="flex items-center justify-between">
          {/* The signed-in user, linked to their GitHub profile. */}
          {session?.login ? (
            <button
              className="text-neutral-400 transition-colors hover:text-sky-400 hover:underline"
              title={userUrl(session.login)}
              onClick={() => void window.holi.openExternal(userUrl(session.login))}
            >
              {session.login}
            </button>
          ) : (
            <p className="text-neutral-400">{session?.login}</p>
          )}
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
