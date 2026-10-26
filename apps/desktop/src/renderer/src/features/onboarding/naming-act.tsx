/**
 * Naming a new vault: one name, slugified live, and the account or org it is
 * created under. The link to join an existing vault instead lives here too.
 *
 * **The owner is part of the address.** Under the name sits the repo's path,
 * `github.com / owner / slug`, and the owner in it is a switcher (after ReUI's
 * `app-shell-7` header crumbs): the choice is made where its effect shows,
 * rather than in a separate field restating the same path.
 *
 * Owns the org list: `read:org` buys exactly one feature, offering an org as
 * the owner, and when it fails the personal account still works.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useAtomValue } from 'jotai'
import { ChevronsUpDown, CornerDownRight, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc'
import { DEFAULT_VAULT_NAME } from '@/state/onboarding-flow'
import { OwnerAvatar, type Owner } from './owner-avatar'
import { sessionAtom } from '@/state/session'

interface Props {
  name: string
  owner: string
  slug: string
  error: string | null
  /** True while this act is the one on screen, so the name field takes focus. */
  active: boolean
  onName: (name: string) => void
  onOwner: (owner: string) => void
  onJoin: () => void
}

export function NamingAct({ name, owner, slug, error, active, onName, onOwner, onJoin }: Props) {
  const session = useAtomValue(sessionAtom)
  const [orgs, setOrgs] = useState<Owner[]>([])
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void trpc.github.orgs
      .query()
      .then((list) => setOrgs(list.map((o) => ({ ...o, kind: 'org' as const }))))
      .catch(() => {})
  }, [])

  // After the act has crossfaded in, not during, or the caret lands mid-fade.
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => nameRef.current?.focus(), 220)
    return () => clearTimeout(t)
  }, [active])

  const owners: Owner[] = session
    ? [
        { login: session.login, avatarUrl: session.avatarUrl, kind: 'personal' },
        ...orgs.filter((o) => o.login !== session.login),
      ]
    : orgs

  return (
    <>
      <div className="obrit-name-stage">
        <div className="obrit-eyebrow">Name your vault</div>
        <Input
          ref={nameRef}
          // The vault name, set as large as the heading it stands in for: no box,
          // display tracking, tight leading for one short line.
          className="obrit-vault-input h-auto border-0 bg-transparent p-0 text-center text-7xl leading-[1.1] font-semibold tracking-[-0.03em] shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0 md:text-7xl dark:bg-transparent"
          // The size follows the length, so a long name shrinks to fit the
          // column instead of scrolling inside the field (index.css cannot
          // count characters; `--name-len` hands it the count).
          style={{ '--name-len': Math.max(name.length, 10) } as CSSProperties}
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder={DEFAULT_VAULT_NAME}
          aria-label="Vault name"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          maxLength={40}
        />
        <div className="obrit-input-underline" />
        {/* A URL reads left to right in any language. */}
        <div className="obrit-path" dir="ltr">
          <span>github.com</span>
          <span className="obrit-path-sep" aria-hidden>
            /
          </span>
          <OwnerSwitcher owners={owners} owner={owner} onOwner={onOwner} />
          <span className="obrit-path-sep" aria-hidden>
            /
          </span>
          <span className="obrit-slug-out" data-default={name.trim() === '' || undefined}>
            {slug}
          </span>
          <span className="obrit-path-private">
            <Lock aria-hidden className="size-3.5" />
            Private
          </span>
        </div>
      </div>

      <div className="obrit-name-actions">
        <Button variant="ghost" onClick={onJoin}>
          <CornerDownRight aria-hidden className="size-3.5 text-muted-foreground" />
          Join vaults in your accounts
        </Button>
        {error && <div className="obrit-error">{error}</div>}
      </div>
    </>
  )
}

/** The owner crumb in the path: who the repo is created under, as a menu of
 *  the signed-in account and its orgs. */
function OwnerSwitcher({
  owners,
  owner,
  onOwner,
}: {
  owners: Owner[]
  owner: string
  onOwner: (owner: string) => void
}) {
  const current = owners.find((o) => o.login === owner)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="obrit-owner min-w-0 shrink">
          <span className="sr-only">Owner: </span>
          <OwnerAvatar owner={current ?? { login: owner, kind: 'personal' }} />
          <span className="truncate">{owner || 'owner'}</span>
          <ChevronsUpDown aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Create under</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={owner} onValueChange={onOwner}>
          {owners.map((o) => (
            <DropdownMenuRadioItem key={o.login} value={o.login}>
              <OwnerAvatar owner={o} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{o.login}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {o.kind === 'personal' ? 'Personal account' : 'Organisation'}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
