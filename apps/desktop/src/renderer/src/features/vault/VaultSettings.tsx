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
import { SidePanel } from '@/composites'
import { Button } from '@/primitives'
import { cn } from '@/lib/cn'
import { collaboratorsErrorText, errorCodeOf } from '@/lib/collaborators-error'
import { trpc } from '@/lib/trpc'
import { sessionAtom, signOutAtom } from '@/state/session'
import { activeRemoteAtom, vaultsAtom } from '@/state/vaults'

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

/** An external link rendered as the `link` Button (an OS-browser jump via
 *  `openExternal`, not in-app navigation — so a button, not an `<a href>`).
 *  Muted until hover, left-aligned, truncating — the shape every profile/URL
 *  link in this panel shares. */
function ExternalLink({
  url,
  onOpen,
  block,
  children,
}: {
  url: string
  onOpen: () => void
  block?: boolean
  children: React.ReactNode
}) {
  return (
    <Button
      variant="link"
      onClick={onOpen}
      title={url}
      className={cn(
        'h-auto max-w-full justify-start truncate p-0 font-normal text-muted-foreground hover:text-primary',
        block && 'block',
      )}
    >
      {children}
    </Button>
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
    <SidePanel title="Settings" onClose={onClose}>
      <div className="flex flex-col gap-4 overflow-y-auto p-4 text-sm">
        <section className="space-y-1">
          <h3 className="font-medium">Vault</h3>
          {entry === undefined ? (
            <p className="text-muted-foreground">no vault open</p>
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
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Remote
                  </div>
                  <ExternalLink
                    url={originUrl(entry.remote)}
                    onOpen={() => void window.holi.openExternal(originUrl(entry.remote))}
                    block
                  >
                    {entry.remote}
                  </ExternalLink>
                </div>
                <div className="space-y-0.5">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Local
                  </div>
                  <ExternalLink
                    url={entry.path}
                    onOpen={() => void window.holi.openPath(entry.path)}
                    block
                  >
                    {displayLocalPath(entry.path, entry.remote)}
                  </ExternalLink>
                </div>
              </div>
            </>
          )}
          {members && (
            <p className={members.visibility === 'public' ? 'text-amber-400' : 'text-muted-foreground'}>
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
            <Button
              variant="link"
              disabled={remote === null}
              className="h-auto gap-1.5 p-0 text-xs font-normal text-muted-foreground no-underline hover:text-foreground hover:no-underline"
              onClick={() => {
                if (remote !== null) void trpc.github.openCollaboratorSettings.mutate({ remote })
              }}
            >
              Manage…
              <GitHubMark />
            </Button>
          </div>
          {/* A refusal is ordinary (signed out, no scope, local-fixture vault) and
              the copy names which one — a bare GitHub "Not Found" reads like a
              crash, and the old catch-all blamed sign-in for all four. The raw
              message stays in the tooltip. */}
          {error !== null && (
            <p className="text-xs text-muted-foreground" title={error.raw}>
              {error.text}
            </p>
          )}
          {members === null && error === null && (
            <p className="text-xs text-muted-foreground">loading…</p>
          )}
          <ul className="space-y-1">
            {members?.collaborators.map((c) => (
              <li key={c.accountId}>
                {/* Each collaborator links to their GitHub profile. */}
                <ExternalLink
                  url={userUrl(c.login)}
                  onOpen={() => void window.holi.openExternal(userUrl(c.login))}
                >
                  {c.login}
                </ExternalLink>
              </li>
            ))}
          </ul>
        </section>

        {/* Account actions live here, not in the footer: the footer reports state,
          * it does not act — and sign out is the one destructive control here. */}
        <section className="mt-auto space-y-2 border-t border-border pt-4">
          <h3 className="font-medium">Account</h3>
          <div className="flex items-center justify-between">
            {/* The signed-in user, linked to their GitHub profile. */}
            {session?.login ? (
              <ExternalLink
                url={userUrl(session.login)}
                onOpen={() => void window.holi.openExternal(userUrl(session.login))}
              >
                {session.login}
              </ExternalLink>
            ) : (
              <p className="text-muted-foreground">{session?.login}</p>
            )}
            <Button
              variant="secondary"
              size="sm"
              // FR-15: this drops the keychain entry and leaves every clone where
              // it is. Removing a vault is a separate, deliberate act.
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </div>
        </section>
      </div>
    </SidePanel>
  )
}
