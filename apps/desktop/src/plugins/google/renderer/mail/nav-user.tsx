import { useState } from "react"
import { CheckIcon, ChevronsUpDownIcon, SettingsIcon } from "lucide-react"
import { useAtomValue } from "jotai"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { activeRemoteAtom } from "@/plugin-api"
import { googleCap, useGoogleAccount } from "../account"
import { initialsOf } from "./data"

// ── Nav User ──

/**
 * The Google account this vault reads mail from, and every other account
 * connected on this machine to switch to. Switching links the vault to that
 * account, as Connections' "Use in this vault" does; connecting and removing
 * stay in Connections.
 *
 * The full width of the list column, above the mailbox it reads.
 */
export function NavUser({
  onManage,
  onError,
}: {
  onManage: () => void
  onError: (message: string) => void
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const { account, accounts, currentSub, refresh } = useGoogleAccount()
  const [switching, setSwitching] = useState(false)
  const email = account?.email ?? ""
  const others = accounts.filter((a) => a.sub !== currentSub)

  const use = (sub: string) => {
    if (remote === null) return
    setSwitching(true)
    void googleCap
      .useAccount(remote, { sub })
      .then(refresh)
      .catch(() => onError("Could not switch accounts. Try again."))
      .finally(() => setSwitching(false))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-start"
          aria-label={
            email === "" ? "Google account" : `Google account ${email}`
          }
        >
          <Avatar size="sm">
            <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
              {initialsOf("", email)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-left">
            {email === "" ? "Not connected" : email}
          </span>
          <ChevronsUpDownIcon
            className="text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>

      {/* Content */}
      <DropdownMenuContent
        side="bottom"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-64"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="flex items-center gap-2.5">
              <Avatar>
                <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
                  {initialsOf("", email)}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col">
                <span className="text-foreground text-sm font-semibold">
                  Google
                </span>
                <span className="text-muted-foreground truncate text-xs font-normal">
                  {email === "" ? "Not connected" : email}
                </span>
              </div>
            </div>
          </DropdownMenuLabel>

          {others.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-muted-foreground text-xs">
                  Read mail from
                </DropdownMenuLabel>
                {accounts.map((a) => (
                  <DropdownMenuItem
                    key={a.sub}
                    disabled={switching}
                    onSelect={() => a.sub !== currentSub && use(a.sub)}
                  >
                    <span className="min-w-0 flex-1 truncate">{a.email}</span>
                    {a.sub === currentSub && <CheckIcon aria-hidden="true" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={onManage}>
            <SettingsIcon aria-hidden="true" />
            Manage connections
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
