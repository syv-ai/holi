/** Account: who is signed in on this machine, and signing out. */
import { useAtomValue } from 'jotai'
import { useState } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { sessionAtom } from '@/state/session'
import { ExternalLinkIcon } from 'lucide-react'
import { SettingsGroup, SettingsFieldRow } from '../settings-kit'
import { SignOutConfirm } from './sign-out-confirm'
import { openExternal } from '@/lib/open-external'
import { useEffect } from 'react'
import { useSettingsVisible } from '../settings-view'

export function AccountPage() {
  const viewer = useAtomValue(sessionAtom)
  const visible = useSettingsVisible()
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!visible) setConfirming(false)
  }, [visible])
  const name = viewer?.name ?? viewer?.login ?? ''

  return (
    <SettingsGroup
      title="GitHub account"
      description="Holi reads and writes your vaults as this account."
    >
      <SettingsFieldRow
        title={
          <span className="flex items-center gap-2">
            <Avatar>
              <AvatarImage src={viewer?.avatarUrl} alt="" />
              <AvatarFallback className="text-xs">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{name}</span>
              <span className="text-muted-foreground truncate text-xs font-normal">
                @{viewer?.login}
              </span>
            </span>
          </span>
        }
      >
        <div className="flex items-center gap-2">
          {viewer?.login ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openExternal(`https://github.com/${viewer.login}`)}
            >
              Profile
              <ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
            </Button>
          ) : null}
          <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
            Sign out
          </Button>
        </div>
      </SettingsFieldRow>
      <SignOutConfirm open={visible && confirming} onOpenChange={setConfirming} />
    </SettingsGroup>
  )
}
