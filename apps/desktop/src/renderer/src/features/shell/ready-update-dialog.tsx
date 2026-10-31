import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { installUpdateAtom, updateStatusAtom } from '@/state/updates'

const DISMISSED_KEY = 'holi:ready-update-dismissed'

function dismissalKey(version: string, channel: string): string {
  return `${channel}:${version}`
}

function wasDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISSED_KEY}:${key}`) === 'true'
  } catch {
    return false
  }
}

function saveDismissal(key: string): void {
  try {
    window.localStorage.setItem(`${DISMISSED_KEY}:${key}`, 'true')
  } catch {
    // The prompt remains dismissible when browser storage is unavailable.
  }
}

export function ReadyUpdateDialog(): React.JSX.Element | null {
  const status = useAtomValue(updateStatusAtom)
  const install = useSetAtom(installUpdateAtom)
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  if (status?.state !== 'ready') return null
  const version = status.availableVersion
  if (version === null) return null
  const readyStatus = status
  const readyKey = dismissalKey(version, readyStatus.channel)
  const open = visible && !wasDismissed(readyKey) && dismissedKey !== readyKey
  const dismiss = () => {
    saveDismissal(readyKey)
    setDismissedKey(readyKey)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss()
      }}
    >
      <DialogContent aria-describedby="ready-update-description">
        <DialogHeader>
          <DialogTitle>Holi {readyStatus.availableVersion} is ready</DialogTitle>
          <DialogDescription id="ready-update-description">
            Restart Holi to install this update. Your vault will be saved and synced before
            restarting.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={dismiss}>
            Later
          </Button>
          <Button type="button" onClick={() => void install()}>
            Restart now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
