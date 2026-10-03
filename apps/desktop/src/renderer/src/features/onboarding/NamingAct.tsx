/**
 * Naming a new vault: one name, slugified live, and the account or org it is
 * created under. The link to join an existing vault instead lives here too.
 *
 * Owns the org list: `read:org` buys exactly one feature, offering an org as
 * the owner, and when it fails the personal account still works.
 */
import { useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/primitives'
import { trpc } from '@/lib/trpc'
import { sessionAtom } from '@/state/session'
import { CEREMONY_GHOST } from './ceremony'

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
  const [orgs, setOrgs] = useState<string[]>([])
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void trpc.github.orgs
      .query()
      .then((list) => setOrgs(list.map((o) => o.login)))
      .catch(() => {})
  }, [])

  // After the act has crossfaded in, not during, or the caret lands mid-fade.
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => nameRef.current?.focus(), 220)
    return () => clearTimeout(t)
  }, [active])

  const owners = session ? [session.login, ...orgs.filter((o) => o !== session.login)] : orgs

  return (
    <>
      <div className="obrit-name-stage">
        <div className="obrit-eyebrow">NAME YOUR VAULT</div>
        <Input
          ref={nameRef}
          variant="display"
          className="obrit-vault-input"
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="your vault"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          maxLength={40}
        />
        <div className="obrit-input-underline" />
        <div className="obrit-path-caption">
          github.com/{owner || '…'}/<span className="obrit-slug-out">{slug || '…'}</span> · private
        </div>
      </div>

      <div className="obrit-form">
        <div className="obrit-field">
          <div className="obrit-field-label">OWNER</div>
          <Select value={owner} onValueChange={onOwner}>
            <SelectTrigger variant="underline">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {owners.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="obrit-field-caption">
            the account or org this private repo is created under.
          </div>
        </div>
        <div className="obrit-cta-row">
          <Button variant="ghost" className={CEREMONY_GHOST} onClick={onJoin}>
            <span aria-hidden>↳</span>
            join one you've been added to
          </Button>
        </div>
        {error && <div className="obrit-error">{error}</div>}
      </div>
    </>
  )
}
