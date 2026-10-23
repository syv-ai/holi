import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { avatarUrl, initials } from "@/lib/planning"
import { PlusIcon } from "lucide-react"

// ── Navbar collaborators (avatar stack + count + add) ──

const VISIBLE_COUNT = 4

export function NavbarCollaborators({
  people,
  onCreate,
  createLabel,
}: {
  people: readonly string[]
  onCreate: () => void
  createLabel: string
}) {
  const visible = people.slice(0, VISIBLE_COUNT)
  const hidden = people.slice(VISIBLE_COUNT)

  return (
    <div className="flex shrink-0 items-center gap-2">
      {/* The block's button widens on hover; a plain one here, since a
          width animation is off the house motion rules. */}
      <Button type="button" size="sm" onClick={onCreate}>
        <PlusIcon data-icon="inline-start" aria-hidden="true" />
        {createLabel}
      </Button>

      {people.length > 0 ? (
        <>
          <Separator orientation="vertical" className="my-auto h-4" />

          {/* List */}
          <AvatarGroup>
            {visible.map((login) => (
              <Avatar key={login} size="sm">
                <AvatarImage src={avatarUrl(login)} alt={login} />
                <AvatarFallback>{initials(login)}</AvatarFallback>
              </Avatar>
            ))}
            {hidden.length > 0 ? (
              <AvatarGroupCount>
                {/* A native button in both bases, so the count lists every
                    member by tap or keyboard at phone widths too. */}
                <Popover>
                  <PopoverTrigger
                    aria-label={`${hidden.length} more: ${hidden.join(", ")}`}
                    className="hover:text-foreground focus-visible:ring-ring/50 flex size-full items-center justify-center rounded-full tabular-nums outline-none focus-visible:ring-2"
                  >
                    +{hidden.length}
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-auto">
                    <div className="flex flex-col gap-2">
                      <span className="text-muted-foreground text-xs font-medium">
                        Members
                      </span>
                      <ul className="flex flex-col gap-1.5">
                        {people.map((login) => (
                          <li key={login} className="flex items-center gap-2">
                            <Avatar size="sm">
                              <AvatarImage src={avatarUrl(login)} alt="" />
                              <AvatarFallback>{initials(login)}</AvatarFallback>
                            </Avatar>
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
        </>
      ) : null}
    </div>
  )
}
