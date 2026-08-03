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
import { Button, Checkbox, Dialog, Tooltip } from '@/primitives'
import { cn } from '@/lib/cn'
import { collaboratorsErrorText, errorCodeOf } from '@/lib/collaborators-error'
import { trpc } from '@/lib/trpc'
import { unpushedWarning } from '@/lib/unpushed-warning'
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

/** A collaborator's GitHub avatar. Falls back to a neutral initial circle when
 *  `avatarUrl` is absent, so the row never shows a broken image (the URL is a
 *  remote githubusercontent.com asset). Decorative — the login beside it names
 *  the person — so `alt=""`. */
function CollaboratorAvatar({ login, avatarUrl }: { login: string; avatarUrl?: string }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className="size-4 shrink-0 rounded-full" />
  }
  return (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] uppercase text-muted-foreground">
      {login.charAt(0)}
    </span>
  )
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
    <Tooltip content={url}>
      <Button
        variant="link"
        onClick={onOpen}
        className={cn(
          'h-auto max-w-full justify-start truncate p-0 font-normal text-muted-foreground hover:text-primary',
          block && 'block',
        )}
      >
        {children}
      </Button>
    </Tooltip>
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
  /** The reset-theme confirm, gated because deleting the committed theme file
   *  removes the shared theme for collaborators too. */
  const [confirmReset, setConfirmReset] = useState(false)
  /** The sign-out confirm: whether it is open, whether to also delete the local
   *  clones, and the unpushed-work warning fetched when it opens (`null` = none,
   *  or not yet fetched). */
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [alsoDeleteClones, setAlsoDeleteClones] = useState(false)
  const [unpushedText, setUnpushedText] = useState<string | null>(null)

  // Ask what deleting the clones would cost, but only when the dialog opens —
  // this walks every clone's git status, so it is not worth doing on every
  // render of the panel. Reset the choice each time it opens.
  useEffect(() => {
    if (!confirmSignOut) return
    setAlsoDeleteClones(false)
    setUnpushedText(null)
    void trpc.vaults.unpushed.query().then((s) => setUnpushedText(unpushedWarning(s)))
  }, [confirmSignOut])

  const resetTheme = () => {
    if (remote === null) return
    // The running app reverts itself: the file deletion fires the watcher, which
    // re-reads the (now empty) theme and clears the applied tokens.
    void trpc.theme.reset.mutate({ remote }).finally(() => setConfirmReset(false))
  }

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
            <Tooltip content={error.raw}>
              <p className="text-xs text-muted-foreground">{error.text}</p>
            </Tooltip>
          )}
          {members === null && error === null && (
            <p className="text-xs text-muted-foreground">loading…</p>
          )}
          <ul className="space-y-1">
            {members?.collaborators.map((c) => (
              <li key={c.accountId} className="flex items-center gap-2">
                <CollaboratorAvatar login={c.login} avatarUrl={c.avatarUrl} />
                {/* Each collaborator links to their GitHub profile. */}
                <ExternalLink
                  url={userUrl(c.login)}
                  onOpen={() => void window.holi.openExternal(userUrl(c.login))}
                >
                  {c.login}
                </ExternalLink>
                {/* Push permission is the whole access model (FR-10/FR-13): the
                    level itself, muted, right-aligned. */}
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {c.permission}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* Appearance. Authoring the theme stays file-based (the agent or the user
          * edits `.holi/theme.json`); the one thing that wants a button is the
          * escape hatch back to standard, because "delete a token you can't see
          * the name of" is not something a file makes easy. */}
        <section className="space-y-2">
          <h3 className="font-medium">Appearance</h3>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              This vault&rsquo;s colours &amp; chrome. Edit <span className="font-mono">.holi/theme.json</span>.
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={remote === null}
              className="shrink-0"
              onClick={() => setConfirmReset(true)}
            >
              Reset theme
            </Button>
          </div>
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
              // FR-15: sign-out drops the keychain entry. Whether it also deletes
              // the clones is the dialog's choice, warned by unpushed work.
              onClick={() => setConfirmSignOut(true)}
            >
              Sign out
            </Button>
          </div>
        </section>
      </div>

      {confirmSignOut && (
        <Dialog open onClose={() => setConfirmSignOut(false)} size="sm">
          <div className="grid gap-4">
            <Dialog.Header>Sign out?</Dialog.Header>
            <Dialog.Body>
              <div className="grid gap-3 text-xs text-muted-foreground">
                <p>
                  Removes your GitHub credential and stops all sync. Your local clones stay on disk
                  unless you choose to delete them below.
                </p>
                <label className="flex items-start gap-2">
                  <Checkbox
                    className="mt-0.5"
                    checked={alsoDeleteClones}
                    onCheckedChange={(v) => setAlsoDeleteClones(v === true)}
                  />
                  <span>
                    Also delete local clones on this machine. They&rsquo;re moved to the Trash, so
                    you can restore them.
                  </span>
                </label>
                {/* FR-15: warn when a clone still holds commits that never reached
                    the remote. Advisory — and the Trash makes it recoverable — so
                    the copy cautions rather than blocks. */}
                {unpushedText !== null && (
                  <p className="text-destructive">
                    {unpushedText}. Deleting the clones moves them to the Trash, where you can still
                    recover that work.
                  </p>
                )}
              </div>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" size="sm" onClick={() => setConfirmSignOut(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setConfirmSignOut(false)
                  void signOut({ deleteClones: alsoDeleteClones })
                }}
              >
                Sign out
              </Button>
            </Dialog.Footer>
          </div>
        </Dialog>
      )}

      {confirmReset && (
        <Dialog open onClose={() => setConfirmReset(false)} size="sm">
          <div className="grid gap-4">
            <Dialog.Header>Reset theme?</Dialog.Header>
            <Dialog.Body>
              <p className="text-xs text-muted-foreground">
                Deletes <span className="font-mono">.holi/theme.json</span> and{' '}
                <span className="font-mono">.holi/theme.local.json</span>, returning the vault to the
                standard look. The shared theme is removed for collaborators on the next sync.
              </p>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={resetTheme}>
                Reset theme
              </Button>
            </Dialog.Footer>
          </div>
        </Dialog>
      )}
    </SidePanel>
  )
}
