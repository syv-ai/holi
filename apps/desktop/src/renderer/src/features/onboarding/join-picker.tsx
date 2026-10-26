/**
 * Join instead of create: the vaults in your accounts, searchable, grouped by
 * the account each lives in.
 *
 * **Every account at once.** The list is GitHub's own `affiliation=owner,
 * collaborator,organization_member` listing, so your repos, your orgs' and
 * ones shared with you arrive together; the field's account selector (after
 * ReUI's `c-input-group-38`) narrows it to one. Grouping by account answers
 * "whose is this" without spelling the owner on every row.
 *
 * Only repos with the `holi-vault` topic, not every code repo: adopting a
 * non-vault would seed Holi's files into someone's codebase. Ones already
 * added are left out, and ones you cannot push to are shown, disabled, as
 * read-only.
 *
 * **An empty list says why**, because the three reasons need different fixes:
 * every vault is already added; nothing carries the topic; or an organisation
 * has not approved Holi, in which case GitHub hides its repos from the
 * listing entirely, and the fix is on GitHub.
 *
 * Owns the repo list. It is fetched the first time the picker opens and kept;
 * a failure stays here, with a retry, rather than losing the user's place.
 */
import { useCallback, useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import type { Repo } from '../../../../main/github/api'
import { ArrowLeft, ChevronDown, Search, X } from 'lucide-react'
import { Badge } from '@/components/reui/badge'
import { Frame, FramePanel } from '@/components/reui/frame'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { IconButton } from '@/composites/icon-button'
import { relativeTime } from '@/lib/relative-time'
import { trpc } from '@/lib/trpc'
import { sessionAtom } from '@/state/session'
import { vaultsAtom } from '@/state/vaults'
import { ActHeading } from './act-heading'
import { OwnerAvatar, type Owner } from './owner-avatar'

/** Where an organisation's approval of Holi is granted (Authorized OAuth Apps). */
const GITHUB_APP_ACCESS = 'https://github.com/settings/applications'

/** The selector's "every account" value: Radix reads an empty string as no
 *  value at all, which would leave the item unmarked. */
const ALL = '*'

interface Props {
  submitting: boolean
  error: string | null
  onPick: (remote: string) => void
  onBack: () => void
}

export function JoinPicker({ submitting, error, onPick, onBack }: Props) {
  const known = useAtomValue(vaultsAtom)
  const session = useAtomValue(sessionAtom)
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [reposError, setReposError] = useState<string | null>(null)
  const [orgs, setOrgs] = useState<Owner[]>([])
  const [search, setSearch] = useState('')
  const [account, setAccount] = useState(ALL)

  const load = useCallback(() => {
    setReposError(null)
    void trpc.github.repos
      .query()
      .then(setRepos)
      .catch((err: unknown) => setReposError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(load, [load])
  // Avatars for the orgs; a repo's owner that is neither you nor an org of
  // yours (a repo shared with you) shows its initial.
  useEffect(() => {
    void trpc.github.orgs
      .query()
      .then((list) => setOrgs(list.map((o) => ({ ...o, kind: 'org' as const }))))
      .catch(() => {})
  }, [])

  const added = new Set(known.map((v) => v.remote))
  const vaults = (repos ?? []).filter((r) => r.isVault)
  const joinable = vaults.filter((r) => !added.has(r.remote))
  const query = search.trim().toLowerCase()
  const matches = joinable
    .filter((r) => account === ALL || ownerOf(r) === account)
    .filter((r) => r.remote.toLowerCase().includes(query))

  const ownerInfo = (login: string): Owner =>
    session?.login === login
      ? { login, avatarUrl: session.avatarUrl, kind: 'personal' }
      : (orgs.find((o) => o.login === login) ?? { login, kind: 'other' })
  // The accounts that have something to join, you first, then by name.
  const accounts = [...new Set(joinable.map(ownerOf))].sort((a, b) =>
    a === session?.login ? -1 : b === session?.login ? 1 : a.localeCompare(b),
  )
  const groups = accounts
    .map((login) => ({
      owner: ownerInfo(login),
      repos: matches.filter((r) => ownerOf(r) === login),
    }))
    .filter((g) => g.repos.length > 0)

  return (
    <div className="flex flex-col items-center gap-6">
      <ActHeading
        center
        title="Join a vault"
        description="The vaults in your accounts and organisations that are not in Holi yet."
      />
      <Frame spacing="sm" className="w-full">
        <FramePanel>
          <div className="flex flex-col gap-2">
            <InputGroup>
              <InputGroupAddon align="inline-start">
                <Search aria-hidden className="size-3.5 text-muted-foreground" />
              </InputGroupAddon>
              <InputGroupInput
                autoFocus
                aria-label="Search vaults"
                placeholder="Search vaults…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <InputGroupAddon align="inline-end">
                <div className="flex items-center gap-1">
                  {search.length > 0 && (
                    <IconButton label="Clear search" onClick={() => setSearch('')}>
                      <X className="size-4" />
                    </IconButton>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <InputGroupButton aria-label="Account" className="text-foreground">
                        {account === ALL ? (
                          'All accounts'
                        ) : (
                          <>
                            <OwnerAvatar owner={ownerInfo(account)} size="sm" />
                            <span className="max-w-32 truncate">{account}</span>
                          </>
                        )}
                        <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
                      </InputGroupButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuLabel>Show vaults from</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={account} onValueChange={setAccount}>
                        <DropdownMenuRadioItem value={ALL}>All accounts</DropdownMenuRadioItem>
                        {accounts.length > 0 && <DropdownMenuSeparator />}
                        {accounts.map((login) => (
                          <DropdownMenuRadioItem key={login} value={login}>
                            <OwnerAvatar owner={ownerInfo(login)} />
                            <span className="truncate">{login}</span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </InputGroupAddon>
            </InputGroup>

            <div className="flex max-h-96 flex-col overflow-y-auto text-start">
              {repos === null && reposError === null && (
                <div role="status" aria-label="Loading vaults" className="flex flex-col gap-1 pt-1">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-9" />
                  ))}
                </div>
              )}
              {reposError !== null && (
                <div className="flex flex-col items-center gap-3 py-6">
                  <p role="alert" className="text-sm text-destructive">
                    Couldn’t load your vaults.
                  </p>
                  <Button variant="outline" size="sm" onClick={load}>
                    Retry
                  </Button>
                </div>
              )}
              {repos !== null &&
                groups.map(({ owner, repos: rows }) => (
                  <div
                    key={owner.login}
                    role="group"
                    aria-label={owner.login}
                    className="flex flex-col gap-px py-1.5"
                  >
                    <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
                      <OwnerAvatar owner={owner} size="sm" />
                      {owner.login}
                    </div>
                    {rows.map((repo) => (
                      <Button
                        key={repo.remote}
                        variant="ghost"
                        disabled={submitting || !repo.canPush}
                        aria-label={repo.remote}
                        className="w-full justify-start font-normal text-foreground"
                        onClick={() => onPick(repo.remote)}
                      >
                        {/* Set in by the avatar's width, so names align under the account. */}
                        <span className="min-w-0 flex-1 truncate ps-6 text-start">
                          {repo.remote.split('/')[1]}
                        </span>
                        {repo.visibility !== 'private' && (
                          <Badge variant="outline" radius="full">
                            {repo.visibility === 'public' ? 'Public' : 'Internal'}
                          </Badge>
                        )}
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {!repo.canPush
                            ? 'Read only'
                            : repo.pushedAt && relativeTime(repo.pushedAt)}
                        </span>
                      </Button>
                    ))}
                  </div>
                ))}
              {repos !== null && groups.length === 0 && (
                <JoinEmpty
                  filtered={query !== '' || account !== ALL}
                  anyVault={vaults.length > 0}
                  onClear={() => {
                    setSearch('')
                    setAccount(ALL)
                  }}
                />
              )}
            </div>
          </div>
        </FramePanel>
      </Frame>
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft aria-hidden className="size-3.5" />
        Back
      </Button>
      {error && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** Why nothing is listed, and the one thing to do about it. */
function JoinEmpty({
  filtered,
  anyVault,
  onClear,
}: {
  filtered: boolean
  anyVault: boolean
  onClear: () => void
}) {
  if (filtered)
    return (
      <div className={EMPTY}>
        <p>No vaults match.</p>
        <Button variant="outline" size="sm" onClick={onClear}>
          Show all vaults
        </Button>
      </div>
    )
  if (anyVault)
    return (
      <div className={EMPTY}>
        <p>Every vault in your accounts is already in Holi.</p>
      </div>
    )
  return (
    <div className={EMPTY}>
      <p>No vaults in your accounts yet.</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        A vault is a repo with the <code className="font-mono">holi-vault</code> topic. An
        organisation’s vaults appear once it has approved Holi on GitHub.
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void window.holi.openExternal(GITHUB_APP_ACCESS)}
      >
        Review organisation access
      </Button>
    </div>
  )
}

const EMPTY = 'flex flex-col items-center gap-3 px-4 py-6 text-center text-sm text-pretty'

const ownerOf = (repo: Repo): string => repo.remote.split('/')[0] ?? repo.remote
