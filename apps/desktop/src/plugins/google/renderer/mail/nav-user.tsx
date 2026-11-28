import { useEffect, useState } from 'react'
import { ChevronsUpDownIcon, SettingsIcon } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useGoogleAccount } from '../account'
import { initialsOf } from './data'

// ── Nav User ──

/**
 * The Google account connected to this vault. Account management stays in Connections.
 *
 * The full width of the list column, above the mailbox it reads.
 */
export function NavUser({ onManage, visible }: { onManage: () => void; visible: boolean }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])
  const { account } = useGoogleAccount()
  const email = account?.email ?? ''

  return (
    <DropdownMenu open={visible && open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-start"
          aria-label={email === '' ? 'Google account' : `Google account ${email}`}
        >
          <Avatar size="sm">
            <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
              {initialsOf('', email)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-left">
            {email === '' ? 'Not connected' : email}
          </span>
          <ChevronsUpDownIcon className="text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>

      {/* Content */}
      <DropdownMenuContent
        side="bottom"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-64"
      >
        <DropdownMenuItem onSelect={onManage}>
          <SettingsIcon aria-hidden="true" />
          Manage connections
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
