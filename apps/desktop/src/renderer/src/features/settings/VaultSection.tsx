/**
 * What this vault is, and who can see it.
 *
 * **Read-only, on purpose.** The old panel drove a connect-a-repo flow that
 * installed a deploy key and a webhook, plus invites, roles and
 * transfer-ownership — all server rules, and GitHub owns access now. Holi does
 * not implement invitation (FR-11); it points at the flow that does.
 *
 * Visibility arrives with the members rather than from a second call this could
 * forget to make. `router.ts` says why: a vault silently becoming public is the
 * highest-severity thing that can happen to it, and this is the only surface
 * that would ever show it.
 *
 * Ported out of `features/vault/VaultSettings.tsx` when the settings tab grew a
 * rail, and put on the shared vocabulary in `settings-ui.tsx` when that tab
 * stopped being six surfaces with six type scales.
 */
import { SiGithub } from '@icons-pack/react-simple-icons'
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import type { Collaborator } from '@holi/shared'
import { Button, Tooltip } from '@/primitives'
import { cn } from '@/lib/cn'
import { collaboratorsErrorText, errorCodeOf } from '@/lib/collaborators-error'
import { trpc } from '@/lib/trpc'
import { activeRemoteAtom, vaultsAtom } from '@/state/vaults'
import {
  ExternalLink,
  SettingsField,
  SettingsHeading,
  SettingsNote,
} from './settings-ui'
import { COLLABORATORS, WHERE_IT_LIVES } from './vault-headings'

/** Mirrors `remoteUrl` in `main/git.ts`, minus the `.git` — this one is for a
 *  human to click, not for git to clone. A vault whose origin is a local path
 *  (a test fixture) still renders its remote; the link simply will not resolve,
 *  which is the honest outcome for a vault that is not on GitHub. */
const originUrl = (remote: string) => `https://github.com/${remote}`

/** A collaborator's GitHub profile. Same honesty caveat as `originUrl`: a login
 *  is always a real GitHub account, so this always resolves. */
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

export function VaultSection(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const entry = useAtomValue(vaultsAtom).find((v) => v.remote === remote)
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
      // should do about it. Say so rather than rendering an empty member list,
      // which would read as "nobody else has access".
      .catch((err: unknown) =>
        setError({
          text: collaboratorsErrorText(errorCodeOf(err), remote),
          raw: err instanceof Error ? err.message : String(err),
        }),
      )
  }, [remote])

  return (
    <div>
      <SettingsHeading title={WHERE_IT_LIVES} />
      {entry === undefined ? (
        <SettingsNote>no vault open</SettingsNote>
      ) : (
        // A vault IS its remote; the local path is the clone FR-15 promises
        // survives a sign-out. Both are links: the remote opens GitHub, the path
        // reveals the folder in Finder.
        <div className="space-y-2">
          <SettingsField label="Remote">
            <ExternalLink
              url={originUrl(entry.remote)}
              onOpen={() => void window.holi.openExternal(originUrl(entry.remote))}
              block
            >
              {entry.remote}
            </ExternalLink>
          </SettingsField>
          <SettingsField label="Local">
            <ExternalLink
              url={entry.path}
              onOpen={() => void window.holi.openPath(entry.path)}
              block
            >
              {displayLocalPath(entry.path, entry.remote)}
            </ExternalLink>
          </SettingsField>
          <SettingsField label="Visibility">
            {members === null ? (
              <SettingsNote>reading…</SettingsNote>
            ) : (
              <p
                className={cn(
                  'text-xs',
                  // The one place this tab shouts. A vault silently becoming
                  // public is the highest-severity thing that can happen to it.
                  members.visibility === 'public' ? 'text-amber-400' : 'text-muted-foreground',
                )}
              >
                {members.visibility}
              </p>
            )}
          </SettingsField>
        </div>
      )}

      <SettingsHeading title={COLLABORATORS} />
      {/* Manage sits inline, subtle: Holi does not implement invitation
          (FR-11), it points at the flow that does, so this is a quiet deep-link
          rather than a primary action. */}
      <div className="flex items-center justify-between gap-3">
        <SettingsNote>Who can see this vault, and at what level.</SettingsNote>
        <Button
          variant="link"
          size="xs"
          disabled={remote === null}
          className="h-auto shrink-0 gap-1.5 p-0 font-normal text-muted-foreground no-underline hover:text-foreground hover:no-underline"
          onClick={() => {
            if (remote !== null) void trpc.github.openCollaboratorSettings.mutate({ remote })
          }}
        >
          Manage…
          <SiGithub size={13} color="currentColor" aria-hidden="true" />
        </Button>
      </div>
      {/* A refusal is ordinary (signed out, no scope, local-fixture vault) and
          the copy names which one — a bare GitHub "Not Found" reads like a
          crash. The raw message stays in the tooltip. */}
      {error !== null && (
        <Tooltip content={error.raw}>
          <p className="mt-2 text-[11px] text-muted-foreground">{error.text}</p>
        </Tooltip>
      )}
      {members === null && error === null && <SettingsNote className="mt-2">loading…</SettingsNote>}
      <ul className="mt-2 space-y-1">
        {members?.collaborators.map((c) => (
          <li key={c.accountId} className="flex items-center gap-2">
            <CollaboratorAvatar login={c.login} avatarUrl={c.avatarUrl} />
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
    </div>
  )
}
