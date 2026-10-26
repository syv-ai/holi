/** The open-at-login switch on the Updates page. */
import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { trpc } from '@/lib/trpc'
import { SettingsFieldRow } from '../settings-kit'

export function OpenAtLoginRow() {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    trpc.app.loginItem
      .query()
      .then((answer) => live && setOpen(answer.openAtLogin))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return (
    <SettingsFieldRow
      title="Open at login"
      description="Start Holi out of sight when you log in, so reminders and sync work from the start."
      htmlFor="settings-open-at-login"
    >
      <Switch
        id="settings-open-at-login"
        disabled={open === null}
        checked={open === true}
        onCheckedChange={(on) =>
          void trpc.app.setLoginItem
            .mutate({ openAtLogin: on })
            .then((answer) => setOpen(answer.openAtLogin))
        }
      />
    </SettingsFieldRow>
  )
}
