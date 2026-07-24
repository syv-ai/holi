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

/** The GitHub mark, inline. This app ships no icon library (the onboarding port
 *  had to strip lucide/shadcn), so the one place that needs a logo carries its
 *  own SVG. `currentColor` lets it inherit the subtle button's text colour. */
function GitHubMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
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
            {/* Where the vault points, and where its clone lives on disk —
                labelled and styled alike so they read as one pair. A vault IS
                its remote (until now nothing said which one); the local path is
                the clone FR-15 promises survives a sign-out, and this is where
                the user is told where it is. Both are links: the remote opens
                GitHub, the path reveals the folder in Finder. */}
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 text-neutral-500">Remote:</span>
              <button
                className="min-w-0 truncate text-left text-sky-400 hover:underline"
                title={originUrl(entry.remote)}
                onClick={() => void window.holi.openExternal(originUrl(entry.remote))}
              >
                {entry.remote}
              </button>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 text-neutral-500">Local:</span>
              <button
                className="min-w-0 truncate text-left text-sky-400 hover:underline"
                title={entry.path}
                onClick={() => void window.holi.openPath(entry.path)}
              >
                {entry.path}
              </button>
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
