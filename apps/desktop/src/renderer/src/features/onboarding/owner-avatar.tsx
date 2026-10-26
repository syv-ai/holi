import { useState } from 'react'
import { cn } from '@/lib/cn'

/** An account a vault belongs to: the signed-in one, an org, or (in the join
 *  list) whoever else shared a repo. */
export interface Owner {
  login: string
  avatarUrl?: string
  kind: 'personal' | 'org' | 'other'
}

/** GitHub's avatar, over the login's initial so an offline machine (no
 *  avatar to fetch) still shows who it is. */
export function OwnerAvatar({ owner, size = 'md' }: { owner: Owner; size?: 'sm' | 'md' }) {
  const [failed, setFailed] = useState(false)
  return (
    <span
      aria-hidden
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground uppercase',
        size === 'sm' ? 'size-5 text-xs' : 'size-6 text-xs',
      )}
    >
      {owner.login.slice(0, 1)}
      {owner.avatarUrl !== undefined && !failed && (
        <img
          src={owner.avatarUrl}
          alt=""
          className="absolute inset-0 size-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  )
}
