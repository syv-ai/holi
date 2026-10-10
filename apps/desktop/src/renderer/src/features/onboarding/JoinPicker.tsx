/**
 * Join instead of create: a searchable list of the vaults you can reach.
 *
 * Only repos with the `holi-vault` topic, not every code repo: adopting a
 * non-vault would seed Holi's files into someone's codebase. Ones already
 * added are left out, and ones you cannot push to are shown disabled.
 *
 * Owns the repo list. It is fetched the first time the picker opens and kept;
 * a failure stays here, with a retry, rather than losing the user's place.
 */
import { useCallback, useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import type { Repo } from '../../../../main/github/api'
import { Button, Input } from '@/primitives'
import { trpc } from '@/lib/trpc'
import { vaultsAtom } from '@/state/vaults'
import { CEREMONY_GHOST } from './ceremony'

interface Props {
  submitting: boolean
  error: string | null
  onPick: (remote: string) => void
  onBack: () => void
}

export function JoinPicker({ submitting, error, onPick, onBack }: Props) {
  const known = useAtomValue(vaultsAtom)
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [reposError, setReposError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback(() => {
    setReposError(null)
    void trpc.github.repos
      .query()
      .then(setRepos)
      .catch((err: unknown) => setReposError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(load, [load])

  const added = new Set(known.map((v) => v.remote))
  const matches = (repos ?? [])
    .filter((r) => r.isVault)
    .filter((r) => r.remote.toLowerCase().includes(search.toLowerCase()))
    .filter((r) => !added.has(r.remote))
    .slice(0, 40)

  return (
    <div className="obrit-name-stage obrit-join">
      <div className="obrit-eyebrow">JOIN A VAULT</div>
      <Input
        autoFocus
        variant="underline"
        className="font-mono text-[13.5px]"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="search your repos…"
        autoComplete="off"
        spellCheck={false}
      />
      <div className="obrit-join-list">
        {repos === null && reposError === null && (
          <p className="obrit-field-caption">loading repos…</p>
        )}
        {reposError !== null && (
          <div className="obrit-join-error">
            <p className="obrit-field-caption is-warn">couldn't load your repos.</p>
            <Button variant="ghost" className={CEREMONY_GHOST} onClick={load}>
              retry
            </Button>
          </div>
        )}
        {repos !== null &&
          matches.map((repo) => (
            <Button
              key={repo.remote}
              variant="ghost"
              disabled={submitting || !repo.canPush}
              className="h-auto w-full justify-start gap-2.5 rounded-md px-2.5 py-2 font-mono text-[13px] font-normal text-foreground"
              onClick={() => onPick(repo.remote)}
              // `title` is a Button *prop*, not a native attribute, so the
              // native-title ban doesn't apply. The Radix Tooltip never fires
              // on a disabled trigger, so the plain title explains it.
              title={repo.canPush ? '' : 'you cannot push to this repo'}
            >
              <span className="obrit-join-remote">{repo.remote}</span>
              {repo.visibility !== 'private' && (
                <span className="obrit-join-vis">{repo.visibility}</span>
              )}
            </Button>
          ))}
        {repos !== null && matches.length === 0 && (
          <p className="obrit-field-caption">no repos match</p>
        )}
      </div>
      <div className="obrit-cta-row">
        <Button variant="ghost" className={CEREMONY_GHOST} onClick={onBack}>
          <span aria-hidden>←</span>
          back
        </Button>
      </div>
      {error && <div className="obrit-error">{error}</div>}
    </div>
  )
}
