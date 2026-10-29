import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { avatarUrl, initials } from '@/lib/planning'

/**
 * One person as a face: their GitHub avatar, their initials while it loads or
 * when there is none. `alt` defaults to the login; pass `""` where the name is
 * written beside it. `image={false}` is for a name that is not a login (a
 * commit author), where a lookup would only guess.
 */
export function PersonAvatar({
  login,
  size = 'sm',
  alt = login,
  image = true,
  className,
}: {
  login: string
  size?: 'sm' | 'default'
  alt?: string
  image?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <Avatar size={size} className={className}>
      {image && <AvatarImage src={avatarUrl(login)} alt={alt} />}
      <AvatarFallback>{initials(login)}</AvatarFallback>
    </Avatar>
  )
}

/**
 * Up to `max` faces, then a count. The count is a button: it lists everyone
 * by tap or keyboard, so a phone-width stack hides nobody.
 */
export function PeopleStack({
  logins,
  max = 3,
}: {
  logins: readonly string[]
  max?: number
}): React.JSX.Element | null {
  if (logins.length === 0) return null
  const shown = logins.slice(0, max)
  const hidden = logins.slice(max)
  return (
    <AvatarGroup aria-label={logins.join(', ')}>
      {shown.map((login) => (
        <PersonAvatar key={login} login={login} />
      ))}
      {hidden.length > 0 ? (
        <AvatarGroupCount>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${hidden.length} more: ${hidden.join(', ')}`}
                className="h-full w-full tabular-nums"
              >
                +{hidden.length}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">Members</span>
                <ul className="flex flex-col gap-1.5">
                  {logins.map((login) => (
                    <li key={login} className="flex items-center gap-2">
                      <PersonAvatar login={login} alt="" />
                      <span className="text-sm">{login}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </PopoverContent>
          </Popover>
        </AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  )
}
